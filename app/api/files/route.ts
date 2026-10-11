import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import { canCreateFile } from '@/lib/platform/permissions';
import { wholesaleVisibleSections } from '@/lib/platform/fileVisibility';
import { FILE_SECTIONS } from '@/lib/platform/fileColors';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import {
  listFilesForCompany,
  listFilesForEmployee,
  grantFileAccess,
  createFile,
  getContactBrief,
  contactDisplayName,
  getCompanyMemberBrief,
  memberDisplayName,
  isFolderType,
  type FolderType,
} from '@/lib/platform/files';
import { getFolderTypeByKey } from '@/lib/platform/folderTypes';
import { isKnownCaseLevel } from '@/lib/caseLevels';
import { evaluateAlerts } from '@/lib/platform/alerts';
import { createComment, notifyMentionedUsers } from '@/lib/platform/comments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files?company_id=<uuid> — list files in ONE company.
 *
 * Company isolation is a hard boundary, enforced here:
 *   • admin   → sees all files in the requested (active) company
 *   • manager → sees all files in his company
 *   • employee→ file_access gating arrives in Phase 3; return nothing for now
 *   • no role in that company → 403
 */
export async function GET(req: NextRequest) {
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

  const companyId = req.nextUrl.searchParams.get('company_id') ?? '';
  if (!companyId) {
    return NextResponse.json(
      { ok: false, error: 'company_id is required.' },
      { status: 400 }
    );
  }

  const role = roleInCompany(pu, companyId);
  if (role === null) {
    // The company is outside the caller's isolation boundary.
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  // An EMPLOYEE only ever sees their OWN folders here — the ones they hold an
  // access grant to, or are the assignee of a task on.
  //
  // This is deliberately independent of their OTHER membership permissions.
  // Those grants (can_create_file, can_edit_file, can_delete_file, …) say
  // what an employee may DO with a folder; they must never widen WHICH
  // folders they can see. Previously any single grant handed the employee
  // the entire company's folder list, so giving someone permission to create
  // a folder also exposed every other client matter in the firm to them.
  //
  // The ONE deliberate exception is wholesale SECTION visibility — the
  // capability tree's "See every folder in the company", which is four grants,
  // one per column of the Folders board, so an admin can let someone review
  // closed matters without also opening every live one.
  //
  // Holding all four is the old blanket grant and takes the whole-company path
  // below. Holding some means "everything of mine, PLUS those sections
  // entire", which listFilesForEmployee expresses in one query. Holding none
  // is the ordinary employee.
  //
  // Managers and admins are unaffected and still see the whole company below.
  if (role === 'employee') {
    const sections = await wholesaleVisibleSections(pu.userId, companyId);
    if (sections.length < FILE_SECTIONS.length) {
      try {
        const files = await listFilesForEmployee(companyId, pu.userId, sections);
        return NextResponse.json({ ok: true, files });
      } catch (err) {
        console.error('List own files error:', err);
        return NextResponse.json(
          { ok: false, error: 'Server error. Please try again.' },
          { status: 500 }
        );
      }
    }
  }

  // Phase 7: EVALUATE-ON-READ. Loading Files is the data-load path we hook the
  // alert engine into (no reliable cron here). Best-effort — a failure must
  // never break the Files list. It is an internal no-op if the company has
  // alerts disabled or the migration isn't applied yet.
  try {
    await evaluateAlerts(companyId);
  } catch (alertErr) {
    console.error('evaluateAlerts (files load) failed:', alertErr);
  }

  try {
    // Per-viewer folder color: everyone who reaches this point (admin/manager,
    // or a permitted employee) sees the AGGREGATE (worst-case across all
    // employees' tasks) — matching the manager-level view their granted
    // permission puts them in. A plain employee's per-viewer color is derived
    // on their own path instead (tasks/mine), never through this route.
    const files = await listFilesForCompany(companyId, {
      userId: pu.userId,
      aggregate: true,
    });
    return NextResponse.json({ ok: true, files });
  } catch (err) {
    console.error('List files error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/files — create a file.
 *
 * Baseline: ADMIN ONLY (global is_admin). An employee/manager may also create
 * if their membership_permissions.can_create_file is set for the target
 * company (lib/platform/permissions.ts) — checked after company_id is known.
 *
 * Fields: company_id (the active company), client_contact_id, opponent,
 * folder_leader_id (a company member), section ∈ {potential, active} (expired is
 * NOT creatable), drive_link optional.
 * created_by is always the caller.
 */
export async function POST(req: NextRequest) {
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

  let body: {
    company_id?: unknown;
    folder_type?: unknown;
    client_contact_id?: unknown;
    opponent_en?: unknown;
    opponent_ar?: unknown;
    folder_leader_id?: unknown;
    section?: unknown;
    drive_link?: unknown;
    case_number?: unknown;
    court?: unknown;
    case_level?: unknown;
    comment?: unknown;
    mentioned_user_ids?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  const companyId =
    typeof body.company_id === 'string' ? body.company_id.trim() : '';
  // Client is chosen from the company's CRM contacts (no free typing).
  const clientContactId =
    typeof body.client_contact_id === 'string'
      ? body.client_contact_id.trim()
      : '';
  // Folder type decides which fields this folder carries. Omitted → 'case',
  // which is exactly the behaviour every folder had before this existed.
  const folderTypeRaw =
    body.folder_type === undefined ? 'case' : body.folder_type;
  if (!isFolderType(folderTypeRaw)) {
    return NextResponse.json(
      { ok: false, error: 'Folder type is required.' },
      { status: 400 }
    );
  }
  const folderType: FolderType = folderTypeRaw;
  let folderTypeRecord;
  try {
    folderTypeRecord = await getFolderTypeByKey(folderType);
  } catch (err) {
    console.error('Create file (folder type lookup) error:', err);
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
  const isContract = folderTypeRecord.layout === 'contract';
  // A CONTRACT folder has no opponent: anything sent is ignored outright, so a
  // crafted request can never plant a "vs" line on a contract.
  const opponentEn =
    !isContract && typeof body.opponent_en === 'string'
      ? body.opponent_en.trim()
      : '';
  const opponentAr =
    !isContract && typeof body.opponent_ar === 'string'
      ? body.opponent_ar.trim()
      : '';
  // Folder leader is chosen from the company's members (no free typing).
  const folderLeaderId =
    typeof body.folder_leader_id === 'string'
      ? body.folder_leader_id.trim()
      : '';
  const driveLinkRaw =
    typeof body.drive_link === 'string' ? body.drive_link.trim() : '';
  const driveLink = driveLinkRaw.length > 0 ? driveLinkRaw : null;
  // Case identity. Optional and free text (see migration #32); capped so a
  // crafted request cannot store an essay in a field the UI renders inline.
  const takeCaseField = (v: unknown): string | null => {
    const t = typeof v === 'string' ? v.trim().slice(0, 120) : '';
    return t.length > 0 ? t : null;
  };
  const caseNumber = takeCaseField(body.case_number);
  const court = takeCaseField(body.court);
  // The level is a FIXED list, so the server accepts only those keys. The
  // dropdown restricts the UI; this is what actually keeps the column clean,
  // since a crafted request bypasses the form entirely.
  const caseLevelRaw = takeCaseField(body.case_level);
  const caseLevel = caseLevelRaw && isKnownCaseLevel(caseLevelRaw) ? caseLevelRaw : null;
  // Optional first comment, posted right after the folder is created.
  const initialComment =
    typeof body.comment === 'string' ? body.comment.trim().slice(0, 4000) : '';
  const initialMentionedUserIds = Array.isArray(body.mentioned_user_ids)
    ? body.mentioned_user_ids.filter((x): x is string => typeof x === 'string')
    : [];
  // Narrow from `string` (not `unknown`) so the literal-union narrowing below
  // is unambiguous for the compiler.
  const section = typeof body.section === 'string' ? body.section : '';

  if (!companyId) {
    return NextResponse.json(
      { ok: false, error: 'company_id is required.' },
      { status: 400 }
    );
  }
  // Even a global admin must target a real company; keep isolation explicit.
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  if (!(await canCreateFile(pu, companyId, isManagerOfCompany(pu, companyId)))) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  if (!clientContactId) {
    return NextResponse.json(
      { ok: false, error: 'A client contact is required.' },
      { status: 400 }
    );
  }
  // Only a CASE requires an opponent; a contract has a client and nothing else.
  if (!isContract && !opponentEn && !opponentAr) {
    return NextResponse.json(
      { ok: false, error: 'At least one opponent name is required.' },
      { status: 400 }
    );
  }
  if (!folderLeaderId) {
    return NextResponse.json(
      { ok: false, error: 'Folder leader is required.' },
      { status: 400 }
    );
  }
  // Only potential/active are creatable — expired is reached only by a move.
  if (section !== 'potential' && section !== 'active') {
    return NextResponse.json(
      { ok: false, error: 'Section must be potential or active.' },
      { status: 400 }
    );
  }

  // The chosen client MUST be a contact in the SAME company (isolation).
  let contact;
  try {
    contact = await getContactBrief(clientContactId);
  } catch (err) {
    console.error('Create file (contact lookup) error:', err);
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
  if (contact.companyId !== companyId) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }
  // files.client (NOT NULL) always carries the contact's display name.
  const clientName = contactDisplayName(contact);

  // The chosen folder leader MUST be a MEMBER of the SAME company (isolation).
  let leader;
  try {
    leader = await getCompanyMemberBrief(folderLeaderId, companyId);
  } catch (err) {
    console.error('Create file (member lookup) error:', err);
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
  // files.managing_lawyer (NOT NULL) always carries the member's display name.
  const leaderName = memberDisplayName(leader);

  // GATE. A manager/admin creates the folder outright; an employee who holds
  // 'files.create' as a "requires approval" grant gets it parked instead, with
  // every already-validated field above carried into the payload so the
  // approver's yes reproduces exactly this request and nothing wider.
  const creatorRole = roleInCompany(pu, companyId);
  try {
    const gate = await gateAction({
      userId: pu.userId,
      companyId,
      capabilityKey: 'files.create',
      payload: {
        folderType,
        client: clientName,
        clientContactId,
        opponent: opponentAr || opponentEn,
        opponentEn: opponentEn.length > 0 ? opponentEn : null,
        opponentAr: opponentAr.length > 0 ? opponentAr : null,
        managingLawyer: leaderName,
        folderLeaderId,
        driveLink,
        section,
        caseNumber,
        court,
        caseLevel,
        comment: initialComment || null,
      },
      summaryEn: `Create a folder for ${clientName}`,
      summaryAr: `إنشاء مجلد للعميل ${clientName}`,
      isPrivileged: creatorRole === 'admin' || creatorRole === 'manager',
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);
  } catch (err) {
    console.error('Create file (approval gate) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }

  try {
    const file = await createFile({
      companyId,
      folderType,
      client: clientName,
      clientContactId,
      // Legacy opponent (NOT NULL) = Arabic-preferred single string; a contract
      // stores the empty string there and NULL in both bilingual columns.
      opponent: opponentAr || opponentEn,
      opponentEn: opponentEn.length > 0 ? opponentEn : null,
      opponentAr: opponentAr.length > 0 ? opponentAr : null,
      managingLawyer: leaderName,
      folderLeaderId,
      driveLink,
      section,
      caseNumber,
      court,
      caseLevel,
      createdBy: pu.userId,
    });

    // An employee only sees folders assigned to them (see the GET above), so a
    // folder they just created would vanish from their own list the moment it
    // was made. Give the creator an access grant so can_create_file stays
    // usable. Not needed for managers/admins, who see the whole company —
    // adding them would only clutter the folder's member list.
    if (creatorRole === 'employee') {
      try {
        await grantFileAccess(file.id, pu.userId);
      } catch (err) {
        // The folder exists; failing to self-grant must not fail the request.
        console.error('Create file (self access grant) error:', err);
      }
    }
    if (initialComment) {
      try {
        await createComment({ fileId: file.id, authorId: pu.userId, body: initialComment });
        if (initialMentionedUserIds.length > 0) {
          await notifyMentionedUsers({
            mentionedUserIds: initialMentionedUserIds,
            companyId,
            authorId: pu.userId,
            authorNameEn: pu.fullNameEn,
            authorNameAr: pu.fullNameAr,
            fileId: file.id,
            fileClientNameEn: file.clientEn,
            fileClientNameAr: file.clientAr,
            commentBody: initialComment,
          });
        }
      } catch (err) {
        // Best-effort: the folder itself was created successfully; a comment
        // failure must not surface as a failed folder creation.
        console.error('Initial comment error:', err);
      }
    }
    return NextResponse.json({ ok: true, file }, { status: 201 });
  } catch (err) {
    console.error('Create file error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
