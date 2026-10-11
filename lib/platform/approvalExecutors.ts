import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import type { ApprovalActionType } from './capabilities';
import {
  createFile,
  deleteFileById,
  grantFileAccess,
  moveFileSection,
  updateFileFields,
  isFolderType,
  type FileSection,
  type UpdateFileInput,
} from './files';
import { createTask, deleteTask, editTask } from './tasks';
import { createComment } from './comments';
import { saveFileSummary } from './fileSummary';
import { createAccessRequest, removeFileAccess } from './access';
import { createLeavePeriod } from './leave';
import { applyAttendanceUpload, type SheetRow } from './attendance';
import { setWorkingHours } from './workingHours';
import { setCapabilityGrants } from './capabilityGrants';
import { createFolderType } from './folderTypes';
import { isKnownCaseLevel } from '../caseLevels';

/**
 * EXECUTORS — what actually happens when an approver says yes.
 *
 * One executor per ApprovalActionType. Each receives the `payload` that the
 * requesting route parked (already validated at request time, then round-
 * tripped through jsonb) and performs exactly that operation, nothing wider.
 *
 * WHY EACH ONE RE-VALIDATES ITS PAYLOAD
 *   The payload left the process as JSON and came back untyped. Even though
 *   the route checked it, a stored request can be days old and the column is
 *   plain jsonb, so every executor re-establishes the shape it needs before
 *   touching the database. A payload that no longer makes sense fails the
 *   request (recorded as 'failed' with a note) rather than throwing a 500 at
 *   the approver — see decideApprovalRequest in approvals.ts.
 *
 * WHAT AN EXECUTOR IS NOT RESPONSIBLE FOR
 *   Authorization. approvals.ts re-checks, at approval time, that the
 *   requester still holds the capability the request came from; if it was
 *   revoked in the meantime the executor is never reached. Executors assume
 *   that check has passed, exactly as the domain functions they call assume
 *   their route already gated them.
 */

export type ExecutorResult = { ok: true } | { ok: false; error: string };

export interface ExecutorContext {
  companyId: string;
  /** The employee who asked. Recorded as the actor on whatever is created. */
  requesterId: string;
}

type Payload = Record<string, unknown>;

function str(payload: Payload, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** A parked case level is re-checked against the fixed list on replay, the same
 *  as every other payload field — the request may be days old. */
function knownCaseLevelOrNull(payload: Payload): string | null {
  const v = nullableStr(payload, 'caseLevel');
  return v && isKnownCaseLevel(v) ? v : null;
}

function nullableStr(payload: Payload, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

const EXECUTORS: Record<
  ApprovalActionType,
  (payload: Payload, ctx: ExecutorContext) => Promise<ExecutorResult>
> = {
  'task.delete': async (payload) => {
    const taskId = str(payload, 'taskId');
    if (!taskId) return { ok: false, error: 'The request is missing its task.' };
    await deleteTask(taskId);
    return { ok: true };
  },

  'task.create': async (payload, ctx) => {
    const fileId = str(payload, 'fileId');
    const title = str(payload, 'title');
    const assigneeId = str(payload, 'assigneeId');
    const approverId = str(payload, 'approverId');
    if (!fileId || !title || !assigneeId || !approverId) {
      return { ok: false, error: 'The request is missing required task fields.' };
    }
    const res = await createTask({
      fileId,
      companyId: ctx.companyId,
      title,
      description: nullableStr(payload, 'description'),
      assigneeId,
      approverId,
      createdBy: ctx.requesterId,
      dueAt: nullableStr(payload, 'dueAt'),
      repeatEveryDays:
        typeof payload.repeatEveryDays === 'number' ? payload.repeatEveryDays : null,
      excludedFromColor: payload.excludedFromColor === true,
    });
    if (!res.ok) {
      // The domain rules can have changed since the request was made — the
      // assignee may have gone on leave, or left the file.
      if (res.code === 'assignee_on_leave') {
        return {
          ok: false,
          error: `That person is on leave until ${res.onLeaveUntil} — the task was not created.`,
        };
      }
      if (res.code === 'bad_assignee') {
        return { ok: false, error: 'The assignee is no longer on this folder.' };
      }
      if (res.code === 'bad_approver') {
        return { ok: false, error: 'The approver is no longer a manager of the company.' };
      }
      return { ok: false, error: 'The task could not be created.' };
    }
    return { ok: true };
  },

  'file.create': async (payload, ctx) => {
    const folderType = payload.folderType;
    const client = str(payload, 'client');
    const clientContactId = str(payload, 'clientContactId');
    const managingLawyer = str(payload, 'managingLawyer');
    const folderLeaderId = str(payload, 'folderLeaderId');
    const section = payload.section;
    if (
      !isFolderType(folderType) ||
      !client ||
      !clientContactId ||
      !managingLawyer ||
      !folderLeaderId ||
      (section !== 'potential' && section !== 'active')
    ) {
      return { ok: false, error: 'The request is missing required folder fields.' };
    }
    const file = await createFile({
      companyId: ctx.companyId,
      folderType,
      client,
      clientContactId,
      opponent: typeof payload.opponent === 'string' ? payload.opponent : '',
      opponentEn: nullableStr(payload, 'opponentEn'),
      opponentAr: nullableStr(payload, 'opponentAr'),
      managingLawyer,
      folderLeaderId,
      driveLink: nullableStr(payload, 'driveLink'),
      section,
      caseNumber: nullableStr(payload, 'caseNumber'),
      court: nullableStr(payload, 'court'),
      caseLevel: knownCaseLevelOrNull(payload),
      createdBy: ctx.requesterId,
    });

    // The requester is an employee (managers are never gated), and an employee
    // only sees folders assigned to them — so without this the folder they
    // asked for would be invisible to them the moment it was approved. Mirrors
    // the same self-grant on the direct path in app/api/files/route.ts.
    try {
      await grantFileAccess(file.id, ctx.requesterId);
    } catch (err) {
      console.error('Approved file.create (self access grant) error:', err);
    }

    // The folder-create form can carry a first comment. It is replayed as the
    // requester so it reads as theirs, not the approver's. @-mentions are NOT
    // re-fired: pinging colleagues about a comment written days earlier, at a
    // moment they had no part in, is noise rather than news.
    const comment = nullableStr(payload, 'comment');
    if (comment) {
      try {
        await createComment({ fileId: file.id, authorId: ctx.requesterId, body: comment });
      } catch (err) {
        console.error('Approved file.create (initial comment) error:', err);
      }
    }
    return { ok: true };
  },

  'file.delete': async (payload) => {
    const fileId = str(payload, 'fileId');
    if (!fileId) return { ok: false, error: 'The request is missing its folder.' };
    const deleted = await deleteFileById(fileId);
    if (!deleted) {
      return { ok: false, error: 'That folder no longer exists.' };
    }
    return { ok: true };
  },

  'file.move': async (payload) => {
    const fileId = str(payload, 'fileId');
    const section = payload.section;
    const valid: FileSection[] = ['potential', 'active', 'expired', 'attrition'];
    if (!fileId || !valid.includes(section as FileSection)) {
      return { ok: false, error: 'The request is missing its folder or target section.' };
    }
    const moved = await moveFileSection(fileId, section as FileSection);
    if (!moved) {
      return { ok: false, error: 'That folder no longer exists.' };
    }
    return { ok: true };
  },

  'file.edit': async (payload) => {
    const fileId = str(payload, 'fileId');
    if (!fileId) return { ok: false, error: 'The request is missing its folder.' };
    // Only the keys the request actually carried are replayed — an absent key
    // means "leave as is", exactly as it did when the edit was submitted.
    const patch: UpdateFileInput = {};
    if (typeof payload.folderType === 'string') patch.folderType = payload.folderType;
    if (payload.clientContactId !== undefined)
      patch.clientContactId = str(payload, 'clientContactId') ?? undefined;
    if (payload.client !== undefined) patch.client = str(payload, 'client') ?? undefined;
    if (payload.opponent !== undefined)
      patch.opponent = typeof payload.opponent === 'string' ? payload.opponent : '';
    if (payload.opponentEn !== undefined) patch.opponentEn = nullableStr(payload, 'opponentEn');
    if (payload.opponentAr !== undefined) patch.opponentAr = nullableStr(payload, 'opponentAr');
    if (payload.managingLawyer !== undefined)
      patch.managingLawyer = str(payload, 'managingLawyer') ?? undefined;
    if (payload.folderLeaderId !== undefined)
      patch.folderLeaderId = str(payload, 'folderLeaderId') ?? undefined;
    if (payload.driveLink !== undefined) patch.driveLink = nullableStr(payload, 'driveLink');

    const updated = await updateFileFields(fileId, patch);
    if (!updated) return { ok: false, error: 'That folder no longer exists.' };
    return { ok: true };
  },

  'file.caseDetails': async (payload) => {
    const fileId = str(payload, 'fileId');
    if (!fileId) return { ok: false, error: 'The request is missing its folder.' };
    const updated = await updateFileFields(fileId, {
      caseNumber: nullableStr(payload, 'caseNumber'),
      court: nullableStr(payload, 'court'),
      caseLevel: knownCaseLevelOrNull(payload),
    });
    if (!updated) return { ok: false, error: 'That folder no longer exists.' };
    return { ok: true };
  },

  'file.summary': async (payload, ctx) => {
    const fileId = str(payload, 'fileId');
    const body = str(payload, 'body');
    if (!fileId || !body) {
      return { ok: false, error: 'The request is missing its folder or summary text.' };
    }
    const lang = payload.lang === 'ar' ? 'ar' : 'en';
    const res = await saveFileSummary({
      fileId,
      body,
      actorId: ctx.requesterId,
      lang,
    });
    if (!res.ok) return { ok: false, error: 'The summary could not be saved.' };
    return { ok: true };
  },

  'comment.add': async (payload, ctx) => {
    const fileId = str(payload, 'fileId');
    const body = str(payload, 'body');
    if (!fileId || !body) {
      return { ok: false, error: 'The request is missing its folder or comment text.' };
    }
    // Posted as the REQUESTER so it reads as theirs. @-mentions are not
    // re-fired: pinging colleagues about a comment written days earlier, at a
    // moment they had no part in, is noise rather than news.
    await createComment({ fileId, authorId: ctx.requesterId, body });
    return { ok: true };
  },

  'task.edit': async (payload, ctx) => {
    const taskId = str(payload, 'taskId');
    const fileId = str(payload, 'fileId');
    if (!taskId || !fileId) {
      return { ok: false, error: 'The request is missing its task.' };
    }
    const res = await editTask({
      taskId,
      fileId,
      companyId: ctx.companyId,
      actorId: ctx.requesterId,
      title: payload.title !== undefined ? str(payload, 'title') ?? undefined : undefined,
      description:
        payload.description === null ? null : nullableStr(payload, 'description') ?? undefined,
      assigneeId:
        payload.assigneeId !== undefined ? str(payload, 'assigneeId') ?? undefined : undefined,
      approverId:
        payload.approverId !== undefined ? str(payload, 'approverId') ?? undefined : undefined,
    });
    if (!res.ok) {
      // The task may have been completed, or the people involved may have moved
      // on, in the time the request was waiting.
      if (res.code === 'locked') {
        return { ok: false, error: 'That task has since been completed and can no longer be edited.' };
      }
      if (res.code === 'not_found') {
        return { ok: false, error: 'That task no longer exists.' };
      }
      if (res.code === 'assignee_on_leave') {
        return { ok: false, error: `That person is on leave until ${res.onLeaveUntil}.` };
      }
      if (res.code === 'bad_assignee') {
        return { ok: false, error: 'The assignee is no longer on this folder.' };
      }
      if (res.code === 'bad_approver') {
        return { ok: false, error: 'The approver is no longer a manager of the company.' };
      }
      return { ok: false, error: 'The task could not be edited.' };
    }
    return { ok: true };
  },

  'folderType.create': async (payload, ctx) => {
    const labelEn = str(payload, 'labelEn');
    const labelAr = str(payload, 'labelAr');
    const layout = payload.layout === 'contract' ? 'contract' : 'case';
    if (!labelEn || !labelAr) {
      return { ok: false, error: 'The request is missing the folder-type labels.' };
    }
    await createFolderType({ labelEn, labelAr, layout, createdBy: ctx.requesterId });
    return { ok: true };
  },

  'access.add': async (payload, ctx) => {
    const fileId = str(payload, 'fileId');
    const userId = str(payload, 'userId');
    if (!fileId || !userId) {
      return { ok: false, error: 'The request is missing its folder or person.' };
    }
    const res = await createAccessRequest({
      fileId,
      companyId: ctx.companyId,
      userId,
      requestedBy: ctx.requesterId,
    });
    if (!res.ok) return { ok: false, error: 'That access request could not be raised.' };
    return { ok: true };
  },

  'access.remove': async (payload, ctx) => {
    const fileId = str(payload, 'fileId');
    const userId = str(payload, 'userId');
    if (!fileId || !userId) {
      return { ok: false, error: 'The request is missing its folder or person.' };
    }
    const res = await removeFileAccess({
      fileId,
      userId,
      actorId: ctx.requesterId,
      reassignTo: nullableStr(payload, 'reassignTo'),
    });
    if (!res.ok) return { ok: false, error: 'That person could not be removed.' };
    return { ok: true };
  },

  'leave.set': async (payload, ctx) => {
    const userId = str(payload, 'userId');
    const startDate = str(payload, 'startDate');
    const endDate = str(payload, 'endDate');
    if (!userId || !startDate || !endDate) {
      return { ok: false, error: 'The request is missing its dates or person.' };
    }
    const res = await createLeavePeriod({
      companyId: ctx.companyId,
      userId,
      startDate,
      endDate,
      note: nullableStr(payload, 'note'),
      createdBy: ctx.requesterId,
    });
    if (!res.ok) {
      // Someone else may have booked overlapping leave while this waited.
      return { ok: false, error: 'That leave could not be booked — it may now overlap existing leave.' };
    }
    return { ok: true };
  },

  'people.schedule': async (payload, ctx) => {
    const userId = str(payload, 'userId');
    if (!userId) return { ok: false, error: 'The request is missing its person.' };
    const days = Array.isArray(payload.workingDays)
      ? payload.workingDays.filter((d): d is number => typeof d === 'number')
      : undefined;
    await setWorkingHours(userId, ctx.companyId, {
      ...(days ? { workingDays: days } : {}),
      ...(payload.startTime !== undefined
        ? { startTime: nullableStr(payload, 'startTime') }
        : {}),
      ...(payload.endTime !== undefined ? { endTime: nullableStr(payload, 'endTime') } : {}),
    });
    return { ok: true };
  },

  'people.zkteco': async (payload, ctx) => {
    const userId = str(payload, 'userId');
    if (!userId) return { ok: false, error: 'The request is missing its person.' };
    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('memberships')
      .update({ zkteco_employee_id: nullableStr(payload, 'zktecoId') })
      .eq('user_id', userId)
      .eq('company_id', ctx.companyId);
    if (res.error) return { ok: false, error: res.error.message };
    return { ok: true };
  },

  'people.permissions': async (payload, ctx) => {
    const userId = str(payload, 'userId');
    if (!userId) return { ok: false, error: 'The request is missing its person.' };
    const keys = Array.isArray(payload.capabilityGrants)
      ? payload.capabilityGrants.filter((k): k is string => typeof k === 'string')
      : [];
    const approvalKeys = Array.isArray(payload.approvalRequired)
      ? payload.approvalRequired.filter((k): k is string => typeof k === 'string')
      : [];
    await setCapabilityGrants(userId, ctx.companyId, keys, ctx.requesterId, approvalKeys);
    return { ok: true };
  },

  'attendance.upload': async (payload, ctx) => {
    const rows = Array.isArray(payload.rows) ? (payload.rows as SheetRow[]) : null;
    if (!rows || rows.length === 0) {
      return { ok: false, error: 'The request has no attendance rows.' };
    }
    const objections = Array.isArray(payload.objections)
      ? (payload.objections as Array<{
          employeeId: string;
          date: string;
          minutes: number;
          comment: string;
        }>)
      : [];
    await applyAttendanceUpload({
      companyId: ctx.companyId,
      actorId: ctx.requesterId,
      // Resolved at request time and carried through, so the objection reads as
      // raised by the person who actually raised it.
      actorNameEn: nullableStr(payload, 'actorNameEn'),
      actorNameAr: nullableStr(payload, 'actorNameAr'),
      rows,
      uploadId: nullableStr(payload, 'uploadId'),
      fileName: nullableStr(payload, 'fileName'),
      fileBase64: nullableStr(payload, 'fileBase64'),
      objections,
      approverId: nullableStr(payload, 'approverId'),
    });
    return { ok: true };
  },

  'contact.create': async (payload, ctx) => {
    const nameEn = nullableStr(payload, 'nameEn');
    const nameAr = nullableStr(payload, 'nameAr');
    if (!nameEn && !nameAr) {
      return { ok: false, error: 'The request has no contact name.' };
    }
    // Mirrors the legacy-column handling in the contacts route: `name` is NOT
    // NULL, so it always carries the Arabic name falling back to English.
    const legacyName = nameAr || nameEn || '';
    const notesEn = nullableStr(payload, 'notesEn');
    const notesAr = nullableStr(payload, 'notesAr');
    const legacyNotes = notesAr || notesEn;

    const supabase = getSupabaseAdmin();
    const res = await supabase.from('contacts').insert({
      company_id: ctx.companyId,
      name: legacyName,
      name_en: nameEn,
      name_ar: nameAr,
      phone: nullableStr(payload, 'phone'),
      phone_country_code: nullableStr(payload, 'phoneCountryCode') ?? '+974',
      email: nullableStr(payload, 'email'),
      notes: legacyNotes,
      notes_en: notesEn,
      notes_ar: notesAr,
      created_by: ctx.requesterId,
    });
    if (res.error) return { ok: false, error: res.error.message };
    return { ok: true };
  },

  'contact.edit': async (payload, ctx) => {
    const contactId = nullableStr(payload, 'contactId');
    if (!contactId) {
      return { ok: false, error: 'The request has no contact to edit.' };
    }
    const nameEn = nullableStr(payload, 'nameEn');
    const nameAr = nullableStr(payload, 'nameAr');
    if (!nameEn && !nameAr) {
      return { ok: false, error: 'The request has no contact name.' };
    }
    // Mirrors the legacy-column handling in the contacts route: `name` is NOT
    // NULL, so it always carries the Arabic name falling back to English.
    const legacyName = nameAr || nameEn || '';
    const notesEn = nullableStr(payload, 'notesEn');
    const notesAr = nullableStr(payload, 'notesAr');
    const legacyNotes = notesAr || notesEn;

    const supabase = getSupabaseAdmin();
    // COMPANY IS RE-CHECKED HERE, not just at request time. A parked request
    // can be approved days later, and the id in the payload is only as
    // trustworthy as the jsonb column it round-tripped through. Scoping the
    // update by company_id means an approved request can never reach a
    // contact belonging to another company, whatever the payload claims.
    const res = await supabase
      .from('contacts')
      .update({
        name: legacyName,
        name_en: nameEn,
        name_ar: nameAr,
        phone: nullableStr(payload, 'phone'),
        phone_country_code: nullableStr(payload, 'phoneCountryCode') ?? '+974',
        email: nullableStr(payload, 'email'),
        notes: legacyNotes,
        notes_en: notesEn,
        notes_ar: notesAr,
      })
      .eq('id', contactId)
      .eq('company_id', ctx.companyId)
      .select('id')
      .maybeSingle();
    if (res.error) return { ok: false, error: res.error.message };
    // Deleted between the request and the decision, or never this company's.
    if (!res.data) {
      return { ok: false, error: 'That contact no longer exists.' };
    }
    return { ok: true };
  },
};

export function isApprovalActionType(v: unknown): v is ApprovalActionType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EXECUTORS, v);
}

/**
 * Run the parked action. Returns a failure result rather than throwing for
 * anything the approver could reasonably be told about; genuine database
 * errors still throw and are caught by the caller.
 */
export async function runApprovedAction(
  actionType: ApprovalActionType,
  payload: Payload,
  ctx: ExecutorContext
): Promise<ExecutorResult> {
  const executor = EXECUTORS[actionType];
  if (!executor) {
    return { ok: false, error: 'This kind of request can no longer be carried out.' };
  }
  return executor(payload, ctx);
}
