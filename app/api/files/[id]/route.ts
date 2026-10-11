import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
  canAdmin,
} from '@/lib/platform/auth';
import {
  canEditFileCore,
  canEditCaseDetails,
  canMoveFileSection,
  canDeleteFile,
} from '@/lib/platform/permissions';
import {
  getFileById,
  isFileAssignedToUser,
  updateFileFields,
  deleteFileById,
  getContactBrief,
  contactDisplayName,
  getCompanyMemberBrief,
  memberDisplayName,
  isFolderType,
  type PlatformFile,
  type UpdateFileInput,
  type FolderType,
} from '@/lib/platform/files';
import {
  isFileSection,
  SECTIONS_HIDDEN_FROM_EMPLOYEES,
  type FileSection,
} from '@/lib/platform/fileColors';
import { isKnownCaseLevel } from '@/lib/caseLevels';
import { wholesaleVisibleSections } from '@/lib/platform/fileVisibility';
import { getFolderTypeByKey } from '@/lib/platform/folderTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * GET /api/files/:id — one file's detail.
 *
 * Company-isolated: the caller must be a global admin, or a manager/member of
 * the file's company. (Employee file_access gating arrives in Phase 3; for now
 * only admins and managers reach the Files UI, so we require one of those.)
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  const id = params.id;
  let file: PlatformFile | null = null;
  try {
    // Only admin/manager pass the role gate below, so the folder color here is
    // the AGGREGATE (worst-case across all employees). Employees never receive
    // this payload; their per-viewer color comes via their own tasks (tasks/mine).
    file = await getFileById(id, { userId: pu.userId, aggregate: true });
  } catch (err) {
    console.error('Get file error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  // An EMPLOYEE may only open a folder assigned to them — an access grant or an
  // assigned task. Membership permissions govern what they may DO with a
  // folder, never which folders exist for them, so a crafted id cannot reach
  // another client's matter. 404 (not 403) so we never confirm a file exists
  // across the isolation boundary.
  const role = roleInCompany(pu, file.companyId);
  if (role !== 'admin' && role !== 'manager') {
    // MIRRORS THE LIST. Every reason a folder appears in an employee's list
    // must also let them open it, or the grid shows cards that 404 when
    // clicked — which is what happened to a folder visible only because it was
    // pinned or general: listed by listFilesForEmployee, then refused here,
    // because isFileAssignedToUser knows only grants and assigned tasks.
    //
    // Checked cheapest-first, and the two flags come free — `file` is already
    // loaded — so the round trips only happen for a folder that is none of
    // these.
    // TERMINAL SECTIONS FIRST, and they overrule every reason below. Expired
    // (closed) and Attrition (client lost) are not an employee's to open at
    // all — not by grant, not by an assigned task, not because the folder is
    // pinned or general. This mirrors listFilesForEmployee, which excludes the
    // same two columns from the list, so the grid and this route cannot
    // disagree about what an employee may see.
    const visible =
      !SECTIONS_HIDDEN_FROM_EMPLOYEES.includes(file.section) &&
      (file.isGeneral ||
        file.isPinned ||
        (await wholesaleVisibleSections(pu.userId, file.companyId)).includes(
          file.section
        ) ||
        (await isFileAssignedToUser(file.id, pu.userId)));
    if (!visible) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
  }

  return NextResponse.json({ ok: true, file });
}

/**
 * PATCH /api/files/:id — edit a file.
 *
 * Two kinds of edit, gated differently and combinable in one request:
 *   • SECTION MOVE — body `{ section }` — allowed for a global admin OR a
 *     MANAGER of the file's company.
 *   • CORE INFO — any of `{ folder_type, client_contact_id, opponent,
 *     folder_leader_id, drive_link }` — ADMIN ONLY. A manager (not admin)
 *     editing core info gets 403.
 *
 * FOLDER TYPE: 'case' keeps client + opponent; 'contract' has a client ONLY —
 * for a contract the opponent is ignored on input and CLEARED in storage, so
 * converting a case into a contract never leaves a stale "vs" behind.
 *
 * Validation: client_contact_id/opponent/folder_leader_id, when present, must be
 * non-empty (the client + folder leader must belong to the file's company);
 * drive_link may be empty/null → stored as null. Only the provided fields are
 * written. Re-checks authorization server-side.
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  const id = params.id;

  let body: {
    section?: unknown;
    case_number?: unknown;
    court?: unknown;
    case_level?: unknown;
    is_general?: unknown;
    is_pinned?: unknown;
    folder_type?: unknown;
    folder_type_2?: unknown;
    client_contact_id?: unknown;
    opponent_en?: unknown;
    opponent_ar?: unknown;
    folder_leader_id?: unknown;
    drive_link?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  // A field "counts" only when its key is present in the body (undefined = leave
  // untouched). Core-info keys drive the admin-only gate below.
  const hasSection = body.section !== undefined;
  const hasClient = body.client_contact_id !== undefined;
  const hasOpponent =
    body.opponent_en !== undefined || body.opponent_ar !== undefined;
  const hasFolderLeader = body.folder_leader_id !== undefined;
  const hasFolderType = body.folder_type !== undefined;
  // The SECOND folder type is core info like the first — it changes what the
  // folder is filed as — so it rides the same admin/can_edit_file gate below.
  const hasFolderType2 = body.folder_type_2 !== undefined;
  // Pinning has its OWN gate (admin or manager), like the general folder: it
  // publishes the folder to every employee in the company, which is an access
  // decision rather than an edit to the folder's contents.
  const hasPinned = body.is_pinned !== undefined;
  // Designating THE general folder, likewise gated on its own (admin-only).
  const hasGeneral = body.is_general !== undefined;
  // Case identity has its OWN gate, wider than the rest of the core info:
  // recording a case number is clerical, whereas changing the client rewrites
  // what the matter is. Deliberately NOT folded into hasCore.
  const hasCaseDetails =
    body.case_number !== undefined ||
    body.court !== undefined ||
    body.case_level !== undefined;
  const hasCore =
    hasClient ||
    hasOpponent ||
    hasFolderLeader ||
    hasFolderType ||
    hasFolderType2 ||
    body.drive_link !== undefined;

  // EVERY gated field counts as something to do. hasCaseDetails was left out
  // when the case fields were split off from hasCore, which made a
  // case-details-ONLY save look like an empty request — so the exact people
  // the split was built for (a manager, or an employee granted only
  // files.caseDetails, who can send nothing else) got "Invalid request."
  // every time. An admin never saw it, because their form also sends the core
  // fields.
  //
  // is_general had the same hole and was missed by that fix: a PATCH carrying
  // only the general-folder flag was rejected as empty, and the admin-only
  // guard below it never ran, so the caller got 400 where 403 or success was
  // the honest answer. Invisible through the UI for the same reason — the
  // edit form always sends the core fields alongside — and found by asking
  // the endpoint directly.
  if (!hasSection && !hasCore && !hasCaseDetails && !hasPinned && !hasGeneral) {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  const patch: UpdateFileInput = {};

  // Case identity — free text, trimmed, capped, and '' stored as null so an
  // emptied field clears rather than saving a blank string.
  const takeCaseField = (v: unknown): string | null => {
    const t = typeof v === 'string' ? v.trim().slice(0, 120) : '';
    return t.length > 0 ? t : null;
  };
  if (body.case_number !== undefined) patch.caseNumber = takeCaseField(body.case_number);
  if (body.court !== undefined) patch.court = takeCaseField(body.court);
  // Normalised once the file is loaded — the "unchanged legacy value" case
  // below needs to compare against what the folder already holds.
  if (body.case_level !== undefined) patch.caseLevel = takeCaseField(body.case_level);

  // THE GENERAL FOLDER — ADMIN ONLY. It is the one folder every employee in the
  // company can see without a grant, so designating it is a company-wide access
  // decision, not a folder edit: a manager who may edit this folder still may
  // not publish it to everyone.
  if (hasGeneral) {
    if (!canAdmin(pu)) {
      return NextResponse.json(
        { ok: false, error: 'Only an admin can set the general folder.' },
        { status: 403 }
      );
    }
    patch.isGeneral = body.is_general === true;
  }

  // Section (admin or manager).
  if (hasSection) {
    if (!isFileSection(body.section)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid section.' },
        { status: 400 }
      );
    }
    patch.section = body.section as FileSection;
  }

  // Client contact — required non-empty string when present. The company
  // isolation check (same company as the file) happens after we load the file.
  let clientContactId = '';
  if (hasClient) {
    clientContactId =
      typeof body.client_contact_id === 'string'
        ? body.client_contact_id.trim()
        : '';
    if (!clientContactId) {
      return NextResponse.json(
        { ok: false, error: 'A client contact is required.' },
        { status: 400 }
      );
    }
  }

  // Folder type — admin-only core field, validated to the two allowed values.
  // The OPPONENT is validated later (after the file is loaded), because whether
  // an opponent is required depends on the folder's EFFECTIVE type: the one
  // being set in this request, or the stored one when the type isn't changing.
  let newFolderType: FolderType | null = null;
  let newFolderTypeLayout: 'case' | 'contract' | null = null;
  if (hasFolderType) {
    if (!isFolderType(body.folder_type)) {
      return NextResponse.json(
        { ok: false, error: 'Folder type is required.' },
        { status: 400 }
      );
    }
    let folderTypeRecord;
    try {
      folderTypeRecord = await getFolderTypeByKey(body.folder_type);
    } catch (err) {
      console.error('Edit file (folder type lookup) error:', err);
      return NextResponse.json(
        { ok: false, error: 'Server error. Please try again.' },
        { status: 500 }
      );
    }
    if (!folderTypeRecord) {
      return NextResponse.json(
        { ok: false, error: 'Unknown folder type.' },
        { status: 400 }
      );
    }
    newFolderType = body.folder_type;
    newFolderTypeLayout = folderTypeRecord.layout;
    patch.folderType = body.folder_type;
  }

  // SECOND folder type (migration #33) — optional, and null/'' clears it.
  //
  // It does NOT touch newFolderTypeLayout: the FIRST type alone decides whether
  // the folder has an opponent. A folder that is both a case and a contract has
  // to render as one of them, and picking by order would mean the fields on the
  // screen depended on which chip was chosen first.
  if (hasFolderType2) {
    const raw = body.folder_type_2;
    if (raw === null || raw === '') {
      patch.folderType2 = null;
    } else if (typeof raw === 'string' && isFolderType(raw)) {
      let secondRecord;
      try {
        secondRecord = await getFolderTypeByKey(raw);
      } catch (err) {
        console.error('Edit file (second folder type lookup) error:', err);
        return NextResponse.json(
          { ok: false, error: 'Server error. Please try again.' },
          { status: 500 }
        );
      }
      if (!secondRecord) {
        return NextResponse.json(
          { ok: false, error: 'Unknown folder type.' },
          { status: 400 }
        );
      }
      patch.folderType2 = raw;
    } else {
      return NextResponse.json(
        { ok: false, error: 'Unknown folder type.' },
        { status: 400 }
      );
    }
  }

  // Folder leader — chosen from the company's members (no free typing). Required
  // non-empty when present; the membership check (same company as the file)
  // happens after we load the file.
  let folderLeaderId = '';
  if (hasFolderLeader) {
    folderLeaderId =
      typeof body.folder_leader_id === 'string'
        ? body.folder_leader_id.trim()
        : '';
    if (!folderLeaderId) {
      return NextResponse.json(
        { ok: false, error: 'A folder leader is required.' },
        { status: 400 }
      );
    }
  }

  // Drive link — optional; empty/null clears it.
  if (body.drive_link !== undefined) {
    const raw = body.drive_link;
    if (raw === null) {
      patch.driveLink = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      patch.driveLink = trimmed.length > 0 ? trimmed : null;
    } else {
      return NextResponse.json(
        { ok: false, error: 'Invalid request.' },
        { status: 400 }
      );
    }
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(id);
  } catch (err) {
    console.error('Edit file (lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  // Company isolation: the caller must at least belong to the FILE's company
  // (any role) — a permission grant only ever exists for an actual member.
  const patchRole = roleInCompany(pu, file.companyId);
  if (patchRole === null) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  // An employee may only edit a folder that is THEIRS — a grant or an assigned
  // task, and NOT the wider reasons GET now accepts (general, pinned, a
  // wholesale section). Being allowed to READ every closed matter is not being
  // allowed to rewrite one, and can_edit_file is about what they may change,
  // not which folders they may reach.
  if (
    patchRole !== 'admin' &&
    patchRole !== 'manager' &&
    !(await isFileAssignedToUser(file.id, pu.userId))
  ) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
  const isManager = isManagerOfCompany(pu, file.companyId);

  // PINNING — ADMIN OR MANAGER, by role, and not grantable. A pinned folder is
  // visible to every employee in the company without an access grant, so
  // pinning hands out access rather than editing a folder. It is one step wider
  // than the general folder's admin-only gate because there is no limit on how
  // many folders may be pinned: an admin cannot be the bottleneck for a routine
  // act, whereas designating THE single general folder is a once-a-year
  // decision. An employee with can_edit_file still may not pin.
  if (hasPinned) {
    if (!canAdmin(pu) && !isManager) {
      return NextResponse.json(
        { ok: false, error: 'Only an admin or manager can pin a folder.' },
        { status: 403 }
      );
    }
    patch.isPinned = body.is_pinned === true;
  }

  // Core-info edits: baseline admin-only, extendable via can_edit_file.
  if (hasCore && !(await canEditFileCore(pu, file.companyId))) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  // Case number / court / level: admin, ANY manager of the company, anyone who
  // may edit the folder outright, or an employee granted 'files.caseDetails'.
  if (
    hasCaseDetails &&
    !(await canEditCaseDetails(
      pu,
      file.companyId,
      isManager,
      await hasCapabilityGrant(pu.userId, file.companyId, 'files.caseDetails')
    ))
  ) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  // Section move: baseline admin-or-manager, extendable via can_move_file_section.
  if (hasSection && !(await canMoveFileSection(pu, file.companyId, isManager))) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  // OPPONENT, resolved against the folder's EFFECTIVE layout.
  const effectiveLayout = newFolderTypeLayout ?? file.folderTypeLayout;
  if (effectiveLayout === 'contract') {
    // A contract has a client and no adversary. Any opponent in the body is
    // IGNORED, and the stored one is CLEARED — including when the folder is
    // being converted from a case, so no stale "vs" line can survive.
    patch.opponentEn = null;
    patch.opponentAr = null;
    patch.opponent = '';
  } else if (hasOpponent) {
    const opponentEn =
      typeof body.opponent_en === 'string' ? body.opponent_en.trim() : '';
    const opponentAr =
      typeof body.opponent_ar === 'string' ? body.opponent_ar.trim() : '';
    if (!opponentEn && !opponentAr) {
      return NextResponse.json(
        { ok: false, error: 'At least one opponent name is required.' },
        { status: 400 }
      );
    }
    patch.opponentEn = opponentEn.length > 0 ? opponentEn : null;
    patch.opponentAr = opponentAr.length > 0 ? opponentAr : null;
    // Legacy opponent (NOT NULL) = Arabic-preferred single string.
    patch.opponent = opponentAr || opponentEn;
  }

  // Validate the chosen client belongs to the SAME company as the file, and
  // write the legacy files.client display name from it.
  if (hasClient) {
    let contact;
    try {
      contact = await getContactBrief(clientContactId);
    } catch (err) {
      console.error('Edit file (contact lookup) error:', err);
      return NextResponse.json(
        { ok: false, error: 'Server error. Please try again.' },
        { status: 500 }
      );
    }
    if (!contact) {
      return NextResponse.json(
        { ok: false, error: 'Selected client was not found.' },
        { status: 400 }
      );
    }
    if (contact.companyId !== file.companyId) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }
    patch.clientContactId = clientContactId;
    patch.client = contactDisplayName(contact);
  }

  // Validate the chosen folder leader is a MEMBER of the file's company, and
  // write the legacy files.managing_lawyer display name from it.
  if (hasFolderLeader) {
    let leader;
    try {
      leader = await getCompanyMemberBrief(folderLeaderId, file.companyId);
    } catch (err) {
      console.error('Edit file (member lookup) error:', err);
      return NextResponse.json(
        { ok: false, error: 'Server error. Please try again.' },
        { status: 500 }
      );
    }
    if (!leader) {
      return NextResponse.json(
        { ok: false, error: 'Selected folder leader is not a company member.' },
        { status: 400 }
      );
    }
    patch.folderLeaderId = folderLeaderId;
    patch.managingLawyer = memberDisplayName(leader);
  }

  // GATE — SECTION MOVES ONLY, and only when the move is the whole request.
  //
  // A PATCH can carry a section move and core edits together, but the parked
  // action ('file.move') moves and nothing else, so replaying a combined
  // request would quietly drop the core edits. Rather than half-apply it, a
  // gated caller sending both is told to move separately. The UI only ever
  // sends a section-only body from the Move modal, so this is a guard against
  // a crafted request, not a workflow anyone hits.
  if (hasSection) {
    const moveGate = await gateAction({
      userId: pu.userId,
      companyId: file.companyId,
      capabilityKey: 'files.move',
      payload: { fileId: file.id, section: patch.section },
      summaryEn: `Move the folder for ${file.clientEn || file.clientAr} to ${patch.section}`,
      summaryAr: `نقل مجلد العميل ${file.clientAr || file.clientEn} إلى ${patch.section}`,
      isPrivileged: isManager || roleInCompany(pu, file.companyId) === 'admin',
    }).catch((err) => {
      console.error('Edit file (move gate) error:', err);
      throw err;
    });
    if (moveGate.kind === 'no_approver') return noApproverResponse();
    if (moveGate.kind === 'held') {
      if (hasCore) {
        return NextResponse.json(
          {
            ok: false,
            code: 'move_needs_own_request',
            error:
              'Moving this folder needs approval, so it has to be done on its own. Save the other changes first, then move it.',
          },
          { status: 409 }
        );
      }
      return heldResponse(moveGate.request.id);
    }
  }

  // CASE LEVEL is a FIXED list. Accept one of the three, a clear, or EXACTLY
  // what this folder already holds. That last case matters: a folder carrying
  // free text from before the list existed round-trips its value through the
  // form untouched, and rejecting it would make any unrelated edit to that
  // folder impossible to save. Anything else is dropped — the dropdown
  // restricts the UI, this is what keeps the column clean against a crafted
  // request.
  if (patch.caseLevel !== undefined && patch.caseLevel !== null) {
    const level = patch.caseLevel;
    if (!isKnownCaseLevel(level) && level !== (file.caseLevel || null)) {
      patch.caseLevel = null;
    }
  }

  // GATE — core edits and case details separately, because they are separate
  // permissions and either can be the gated one. A caller doing both at once
  // where EITHER is gated is refused rather than half-applied, for the same
  // reason as the section move above.
  //
  // Written out twice rather than through a helper so the capability key is a
  // literal at the call site: that is what the wiring guard in
  // test/lib/approval-gate-wiring.test.ts reads to prove every gateable
  // permission actually reaches a route.
  const folderLabel = file.clientEn || file.clientAr;
  const isCompanyAdmin = roleInCompany(pu, file.companyId) === 'admin';
  const mixedEditRefusal = (what: string) =>
    NextResponse.json(
      {
        ok: false,
        code: 'edit_needs_own_request',
        error: `${what} needs approval, so it has to be done on its own. Save the other changes first.`,
      },
      { status: 409 }
    );

  try {
    if (hasCore) {
      const gate = await gateAction({
        userId: pu.userId,
        companyId: file.companyId,
        capabilityKey: 'files.edit',
        payload: {
          fileId: file.id,
          ...(patch.folderType !== undefined ? { folderType: patch.folderType } : {}),
          ...(patch.client !== undefined ? { client: patch.client } : {}),
          ...(patch.clientContactId !== undefined
            ? { clientContactId: patch.clientContactId }
            : {}),
          ...(patch.opponent !== undefined ? { opponent: patch.opponent } : {}),
          ...(patch.opponentEn !== undefined ? { opponentEn: patch.opponentEn } : {}),
          ...(patch.opponentAr !== undefined ? { opponentAr: patch.opponentAr } : {}),
          ...(patch.managingLawyer !== undefined
            ? { managingLawyer: patch.managingLawyer }
            : {}),
          ...(patch.folderLeaderId !== undefined
            ? { folderLeaderId: patch.folderLeaderId }
            : {}),
          ...(patch.driveLink !== undefined ? { driveLink: patch.driveLink } : {}),
        },
        summaryEn: `Edit the folder for ${folderLabel}`,
        summaryAr: `تعديل مجلد العميل ${folderLabel}`,
        isPrivileged: isCompanyAdmin,
      });
      if (gate.kind === 'no_approver') return noApproverResponse();
      if (gate.kind === 'held') {
        if (hasCaseDetails || hasSection) return mixedEditRefusal('Editing this folder');
        return heldResponse(gate.request.id);
      }
    }

    if (hasCaseDetails) {
      const gate = await gateAction({
        userId: pu.userId,
        companyId: file.companyId,
        capabilityKey: 'files.caseDetails',
        payload: {
          fileId: file.id,
          caseNumber: patch.caseNumber ?? null,
          court: patch.court ?? null,
          caseLevel: patch.caseLevel ?? null,
        },
        summaryEn: `Set the case details for ${folderLabel}`,
        summaryAr: `تحديد بيانات القضية للعميل ${folderLabel}`,
        // A manager holds this one by role, so they are never gated on it.
        isPrivileged: isCompanyAdmin || isManager,
      });
      if (gate.kind === 'no_approver') return noApproverResponse();
      if (gate.kind === 'held') {
        if (hasCore || hasSection) return mixedEditRefusal('Setting the case details');
        return heldResponse(gate.request.id);
      }
    }

    const updated = await updateFileFields(id, patch);
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, file: updated });
  } catch (err) {
    // The database enforces at most one general folder per company (a partial
    // unique index). Report that as the conflict it is rather than a 500.
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : '';
    if (code === '23505' || /files_one_general_per_company/.test(message)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'general_folder_exists',
          error:
            'This company already has a general folder. Turn it off on that folder first.',
        },
        { status: 409 }
      );
    }
    console.error('Edit file error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/files/:id — permanently delete a folder and all it owns.
 *
 * ADMIN ONLY. A manager/employee (or any non-admin) is refused server-side even
 * if they craft the request directly — hiding the button is not the guard. We
 * still load the file first to (a) confirm it exists and (b) capture its
 * company_id, keeping per-company isolation legible; the actual delete cascades
 * to the file's tasks, task history, access grants and access requests via the
 * DB `on delete cascade` graph (see deleteFileById), so it is atomic and cannot
 * leave orphans.
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  const id = params.id;
  let file: PlatformFile | null = null;
  try {
    file = await getFileById(id);
  } catch (err) {
    console.error('Delete file (lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  // company_id captured for isolation legibility; a global admin reaches every
  // company, so this is not an extra gate — just a defensive presence check.
  if (!file.companyId) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  // An employee may only delete a folder that is THEIRS (see GET).
  const delRole = roleInCompany(pu, file.companyId);
  if (
    delRole !== 'admin' &&
    delRole !== 'manager' &&
    !(await isFileAssignedToUser(file.id, pu.userId))
  ) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  // Baseline admin-only, extendable via can_delete_file.
  if (!(await canDeleteFile(pu, file.companyId))) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  try {
    // GATE. An employee holding 'files.delete' as a "requires approval" grant
    // gets the deletion parked instead of performed; a manager/admin deletes
    // outright. Deliberately AFTER the checks above, so only a deletion that
    // would actually have been allowed is ever parked.
    const gate = await gateAction({
      userId: pu.userId,
      companyId: file.companyId,
      capabilityKey: 'files.delete',
      payload: { fileId: file.id },
      summaryEn: `Delete the folder for ${file.clientEn || file.clientAr}`,
      summaryAr: `حذف مجلد العميل ${file.clientAr || file.clientEn}`,
      isPrivileged: delRole === 'admin' || delRole === 'manager',
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const deleted = await deleteFileById(id);
    if (!deleted) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete file error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
