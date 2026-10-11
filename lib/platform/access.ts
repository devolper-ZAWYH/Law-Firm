import 'server-only';
import { getSupabaseAdmin } from '../supabase';

/**
 * File-access lifecycle data-access layer (Phase 3).
 *
 * Pure data access over `file_access` and `access_requests` using the
 * service-role client. It performs NO authorization — every caller (the API
 * routes) resolves the platform user and re-checks the two-layer model BEFORE
 * calling these, and always scopes to a single file (whose company is the hard
 * isolation boundary).
 *
 * THE ASYMMETRIC GATE:
 *   • ADD is hard    → createAccessRequest() only records a PENDING request; it
 *                      grants ZERO capability. approveAccessRequest() (Admin
 *                      only, enforced by the route) is what creates the
 *                      file_access row.
 *   • REMOVE is easy → removeFileAccess() deletes directly (Manager/Admin), with
 *                      a LAST-PERSON guard so a file always keeps ≥1 assignee.
 *
 * PostgREST embedding is avoided on purpose: access_requests has three FKs to
 * app_users (user_id, requested_by, decided_by), which makes automatic joins
 * ambiguous. We fetch rows then batch-resolve the referenced users/files/
 * companies by id — the same manual-join pattern used elsewhere in lib/platform.
 */

// ---- Public shapes ---------------------------------------------------------

/** A person surfaced in an access list or request (never includes secrets). */
export interface AccessPerson {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
}

/** A pending request as shown in a file's Access section. */
export interface FilePendingRequest {
  id: string;
  employee: AccessPerson;
  requestedBy: AccessPerson;
  createdAt: string;
}

/** Everything the file-detail Access section needs. */
export interface FileAccessSnapshot {
  members: AccessPerson[];
  pending: FilePendingRequest[];
  /** Company employees not already on the file and not already pending. */
  assignableEmployees: AccessPerson[];
}

/** A pending request as shown in the Admin "Access Requests" view. */
export interface PendingRequestFull {
  id: string;
  file: {
    id: string;
    client: string;
    opponent: string;
    companyId: string;
    companyNameEn: string;
    companyNameAr: string;
  };
  employee: AccessPerson;
  requestedBy: AccessPerson;
  createdAt: string;
}

// ---- Raw row shapes (untyped PostgREST JSON; cast defensively) -------------

interface UserRow {
  id: string;
  username: string;
  full_name_en: string | null;
  full_name_ar: string | null;
}
interface FileAccessRow {
  user_id: string;
  granted_at: string;
}
interface AccessRequestRow {
  id: string;
  file_id: string;
  user_id: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}
interface FileBriefRow {
  id: string;
  company_id: string;
  client: string;
  opponent: string;
}
interface CompanyBriefRow {
  id: string;
  name_en: string;
  name_ar: string;
}

const USER_COLUMNS = 'id, username, full_name_en, full_name_ar';

function personFromRow(row: UserRow): AccessPerson {
  return {
    userId: row.id,
    username: row.username,
    fullNameEn: row.full_name_en,
    fullNameAr: row.full_name_ar,
  };
}

/** Batch-resolve users by id into a Map (missing ids simply absent). */
export async function fetchUsersByIds(
  ids: string[]
): Promise<Map<string, AccessPerson>> {
  const map = new Map<string, AccessPerson>();
  const unique = Array.from(new Set(ids.filter((x) => !!x)));
  if (unique.length === 0) return map;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('app_users')
    .select(USER_COLUMNS)
    .in('id', unique);
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as UserRow[] | null) ?? [];
  for (const r of rows) map.set(r.id, personFromRow(r));
  return map;
}

// ---- Membership helpers ----------------------------------------------------

/**
 * The employees (membership role = 'employee') of a company, as people. Used
 * both for validating a request target and for the "add employee" picker.
 */
export async function listCompanyEmployees(
  companyId: string
): Promise<AccessPerson[]> {
  const supabase = getSupabaseAdmin();
  const memRes = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'employee');
  if (memRes.error) throw new Error(memRes.error.message);
  const memRows = (memRes.data as { user_id: string }[] | null) ?? [];
  const ids = memRows.map((m) => m.user_id);
  const byId = await fetchUsersByIds(ids);
  const people: AccessPerson[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) people.push(p);
  }
  // Stable, human-friendly order.
  people.sort((a, b) =>
    (a.fullNameEn ?? a.username).localeCompare(b.fullNameEn ?? b.username)
  );
  return people;
}

/** True iff `userId` is an `employee` member of `companyId`. */
export async function isCompanyEmployee(
  userId: string,
  companyId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .eq('role', 'employee')
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data != null;
}

/**
 * The managers (membership role = 'manager') of a company, as people. Used to
 * populate the task assignee/approver pickers (spec §6): an approver must be a
 * manager of the file's company; an assignee may be a file member OR a manager.
 */
export async function listCompanyManagers(
  companyId: string
): Promise<AccessPerson[]> {
  const supabase = getSupabaseAdmin();
  const memRes = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'manager');
  if (memRes.error) throw new Error(memRes.error.message);
  const memRows = (memRes.data as { user_id: string }[] | null) ?? [];
  const ids = memRows.map((m) => m.user_id);
  const byId = await fetchUsersByIds(ids);
  const people: AccessPerson[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) people.push(p);
  }
  people.sort((a, b) =>
    (a.fullNameEn ?? a.username).localeCompare(b.fullNameEn ?? b.username)
  );
  return people;
}

/** True iff `userId` is a `manager` member of `companyId`. */
export async function isCompanyManager(
  userId: string,
  companyId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .eq('role', 'manager')
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data != null;
}

// ---- file_access reads -----------------------------------------------------

/** The user ids currently on a file, in grant order (oldest first). Exported
 * for the task layer (validating an assignee is on the file). */
export async function listFileMemberIds(fileId: string): Promise<string[]> {
  return fileAccessUserIds(fileId);
}

/** True iff `userId` currently has access to `fileId`. */
export async function isFileMember(
  fileId: string,
  userId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_access')
    .select('id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data != null;
}

/** The current members of a file, as people (grant order). */
export async function listFileMembers(
  fileId: string
): Promise<AccessPerson[]> {
  const ids = await fileAccessUserIds(fileId);
  const byId = await fetchUsersByIds(ids);
  const people: AccessPerson[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) people.push(p);
  }
  return people;
}

/** The user ids currently on a file, in grant order (oldest first). */
async function fileAccessUserIds(fileId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_access')
    .select('user_id, granted_at')
    .eq('file_id', fileId)
    .order('granted_at', { ascending: true });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as FileAccessRow[] | null) ?? [];
  return rows.map((r) => r.user_id);
}

/** Pending requests for one file (raw rows, oldest first). */
async function pendingRequestRowsForFile(
  fileId: string
): Promise<AccessRequestRow[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('access_requests')
    .select(
      'id, file_id, user_id, requested_by, status, decided_by, created_at, decided_at'
    )
    .eq('file_id', fileId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (res.error) throw new Error(res.error.message);
  return (res.data as AccessRequestRow[] | null) ?? [];
}

/**
 * Full Access snapshot for a file: current members, pending requests, and the
 * company employees who are eligible to be added (not a member, not pending).
 */
export async function getFileAccessSnapshot(
  fileId: string,
  companyId: string
): Promise<FileAccessSnapshot> {
  // These three do not feed each other, so they go out TOGETHER. Awaited one
  // after another they cost three full round trips to a database that is a
  // continent away, and the drawer waits through all of them before it can
  // draw anything.
  const [memberIds, pendingRows, employees] = await Promise.all([
    fileAccessUserIds(fileId),
    pendingRequestRowsForFile(fileId),
    listCompanyEmployees(companyId),
  ]);

  // Resolve every user referenced by members + pending (employee + manager).
  const referenced = new Set<string>(memberIds);
  for (const r of pendingRows) {
    referenced.add(r.user_id);
    referenced.add(r.requested_by);
  }

  // The company employees we just loaded ARE people records, so start the map
  // from them. In the ordinary case — every member and requester is an
  // employee of the file's company — nothing is left to look up and the final
  // round trip disappears entirely. Only genuine outsiders (a global admin who
  // granted access, a member since moved companies) are fetched.
  const byId = new Map<string, AccessPerson>();
  for (const e of employees) byId.set(e.userId, e);
  const missing = Array.from(referenced).filter((id) => !byId.has(id));
  if (missing.length > 0) {
    for (const [id, person] of await fetchUsersByIds(missing)) {
      byId.set(id, person);
    }
  }

  const members: AccessPerson[] = [];
  for (const id of memberIds) {
    const p = byId.get(id);
    if (p) members.push(p);
  }

  const pending: FilePendingRequest[] = [];
  const pendingUserIds = new Set<string>();
  for (const r of pendingRows) {
    pendingUserIds.add(r.user_id);
    const employee = byId.get(r.user_id);
    const requestedBy = byId.get(r.requested_by);
    if (!employee || !requestedBy) continue; // referenced user vanished — skip
    pending.push({
      id: r.id,
      employee,
      requestedBy,
      createdAt: r.created_at,
    });
  }

  const memberIdSet = new Set(memberIds);
  const assignableEmployees = employees.filter(
    (e) => !memberIdSet.has(e.userId) && !pendingUserIds.has(e.userId)
  );

  return { members, pending, assignableEmployees };
}

// ---- Admin: list ALL pending requests --------------------------------------

/**
 * Every pending request across all companies, enriched with file + company +
 * employee + manager info. Admin-only (enforced by the route). Newest first.
 */
export async function listAllPendingRequests(
  status: 'pending' | 'approved' | 'rejected' = 'pending'
): Promise<PendingRequestFull[]> {
  const supabase = getSupabaseAdmin();
  const reqRes = await supabase
    .from('access_requests')
    .select(
      'id, file_id, user_id, requested_by, status, decided_by, created_at, decided_at'
    )
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (reqRes.error) throw new Error(reqRes.error.message);
  const reqRows = (reqRes.data as AccessRequestRow[] | null) ?? [];
  if (reqRows.length === 0) return [];

  // Batch-resolve files, then companies, then users.
  const fileIds = Array.from(new Set(reqRows.map((r) => r.file_id)));
  const filesRes = await supabase
    .from('files')
    .select('id, company_id, client, opponent')
    .in('id', fileIds);
  if (filesRes.error) throw new Error(filesRes.error.message);
  const fileRows = (filesRes.data as FileBriefRow[] | null) ?? [];
  const fileById = new Map<string, FileBriefRow>(
    fileRows.map((f) => [f.id, f])
  );

  const companyIds = Array.from(new Set(fileRows.map((f) => f.company_id)));
  const compById = new Map<string, CompanyBriefRow>();
  if (companyIds.length > 0) {
    const compRes = await supabase
      .from('companies')
      .select('id, name_en, name_ar')
      .in('id', companyIds);
    if (compRes.error) throw new Error(compRes.error.message);
    const compRows = (compRes.data as CompanyBriefRow[] | null) ?? [];
    for (const c of compRows) compById.set(c.id, c);
  }

  const userIds: string[] = [];
  for (const r of reqRows) {
    userIds.push(r.user_id, r.requested_by);
  }
  const userById = await fetchUsersByIds(userIds);

  const out: PendingRequestFull[] = [];
  for (const r of reqRows) {
    const file = fileById.get(r.file_id);
    const employee = userById.get(r.user_id);
    const requestedBy = userById.get(r.requested_by);
    if (!file || !employee || !requestedBy) continue; // enrichment gap — skip
    const company = compById.get(file.company_id);
    out.push({
      id: r.id,
      file: {
        id: file.id,
        client: file.client,
        opponent: file.opponent,
        companyId: file.company_id,
        companyNameEn: company?.name_en ?? '',
        companyNameAr: company?.name_ar ?? '',
      },
      employee,
      requestedBy,
      createdAt: r.created_at,
    });
  }
  return out;
}

// ---- Create a request (ADD is hard) ----------------------------------------

export type CreateRequestResult =
  | { ok: true; request: FilePendingRequest }
  | { ok: false; code: 'not_employee' | 'already_member' | 'already_pending' };

/**
 * Record a PENDING request to add `userId` to `fileId`. Grants ZERO capability
 * — only Admin approval creates the file_access row. Validates that the target
 * is an EMPLOYEE of the file's company (cross-company / non-employee → refused),
 * and that no duplicate (already a member / already pending) exists.
 */
export async function createAccessRequest(input: {
  fileId: string;
  companyId: string;
  userId: string;
  requestedBy: string;
}): Promise<CreateRequestResult> {
  const { fileId, companyId, userId, requestedBy } = input;
  const supabase = getSupabaseAdmin();

  // Company isolation + role check: must be an employee of THIS company.
  const employeeOk = await isCompanyEmployee(userId, companyId);
  if (!employeeOk) return { ok: false, code: 'not_employee' };

  // Already on the file?
  const memRes = await supabase
    .from('file_access')
    .select('id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memRes.error) throw new Error(memRes.error.message);
  if (memRes.data != null) return { ok: false, code: 'already_member' };

  // Already a pending request?
  const penRes = await supabase
    .from('access_requests')
    .select('id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();
  if (penRes.error) throw new Error(penRes.error.message);
  if (penRes.data != null) return { ok: false, code: 'already_pending' };

  const insRes = await supabase
    .from('access_requests')
    .insert({
      file_id: fileId,
      user_id: userId,
      requested_by: requestedBy,
      status: 'pending',
    })
    .select(
      'id, file_id, user_id, requested_by, status, decided_by, created_at, decided_at'
    )
    .single();
  if (insRes.error) {
    // 23505 = unique-ish race (a concurrent identical pending insert). Treat as
    // already-pending rather than a 500.
    if ((insRes.error as { code?: string }).code === '23505') {
      return { ok: false, code: 'already_pending' };
    }
    throw new Error(insRes.error.message);
  }
  const row = insRes.data as AccessRequestRow;

  const byId = await fetchUsersByIds([row.user_id, row.requested_by]);
  const employee = byId.get(row.user_id);
  const requester = byId.get(row.requested_by);
  // These were just validated to exist; guard for the type-checker regardless.
  if (!employee || !requester) {
    return { ok: false, code: 'not_employee' };
  }
  return {
    ok: true,
    request: {
      id: row.id,
      employee,
      requestedBy: requester,
      createdAt: row.created_at,
    },
  };
}

// ---- Approve / reject a request (ADMIN only, enforced by route) ------------

export type DecideResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'not_pending' };

/**
 * Approve a pending request: create the file_access row (idempotent) and mark
 * the request approved. Admin-only (enforced by the route).
 */
export async function approveAccessRequest(
  requestId: string,
  adminId: string
): Promise<DecideResult> {
  const supabase = getSupabaseAdmin();
  const reqRes = await supabase
    .from('access_requests')
    .select('id, file_id, user_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (reqRes.error) throw new Error(reqRes.error.message);
  const row = reqRes.data as
    | { id: string; file_id: string; user_id: string; status: string }
    | null;
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'not_pending' };

  // Create the access grant. Unique(file_id,user_id) makes this idempotent;
  // ignore a duplicate (the person already had access).
  const grantRes = await supabase
    .from('file_access')
    .insert({ file_id: row.file_id, user_id: row.user_id });
  if (grantRes.error && (grantRes.error as { code?: string }).code !== '23505') {
    throw new Error(grantRes.error.message);
  }

  const updRes = await supabase
    .from('access_requests')
    .update({
      status: 'approved',
      decided_by: adminId,
      decided_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending'); // guard against a concurrent decision
  if (updRes.error) throw new Error(updRes.error.message);

  return { ok: true };
}

/** Reject a pending request. Nothing else changes. Admin-only (route). */
export async function rejectAccessRequest(
  requestId: string,
  adminId: string
): Promise<DecideResult> {
  const supabase = getSupabaseAdmin();
  const reqRes = await supabase
    .from('access_requests')
    .select('id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (reqRes.error) throw new Error(reqRes.error.message);
  const row = reqRes.data as { id: string; status: string } | null;
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'not_pending' };

  const updRes = await supabase
    .from('access_requests')
    .update({
      status: 'rejected',
      decided_by: adminId,
      decided_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (updRes.error) throw new Error(updRes.error.message);

  return { ok: true };
}

// ---- Remove from a file (REMOVE is easy) -----------------------------------

export type RemoveAccessResult =
  | { ok: true }
  | {
      ok: false;
      code: 'not_found' | 'last_person' | 'bad_reassign' | 'reassign_required';
    };

/** Statuses that count as "still owned" by the assignee (must be reassigned). */
const UNFINISHED_STATUSES = ['open', 'awaiting_approval'] as const;

/**
 * How many UNFINISHED (open + awaiting_approval) tasks `userId` has on `fileId`.
 * Approved tasks are done and stay with their historical assignee.
 */
async function countUnfinishedTasksOnFile(
  fileId: string,
  userId: string
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('file_id', fileId)
    .eq('assignee_id', userId)
    .in('status', UNFINISHED_STATUSES as unknown as string[]);
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

/**
 * PHASE-4 FORCED REASSIGNMENT. Move `fromUserId`'s UNFINISHED (open +
 * awaiting_approval) tasks on the file to `toUserId`, writing a 'reassigned'
 * task_event (actor = `actorId`) for each moved task. Returns how many moved.
 * Approved tasks are left untouched. `toUserId` MUST already be on the file
 * (validated by the caller before this runs).
 */
async function reassignOpenTasks(
  fileId: string,
  fromUserId: string,
  toUserId: string,
  actorId: string
): Promise<number> {
  const supabase = getSupabaseAdmin();

  // Grab the ids first so we can write one history event per moved task.
  const findRes = await supabase
    .from('tasks')
    .select('id')
    .eq('file_id', fileId)
    .eq('assignee_id', fromUserId)
    .in('status', UNFINISHED_STATUSES as unknown as string[]);
  if (findRes.error) throw new Error(findRes.error.message);
  const rows = (findRes.data as { id: string }[] | null) ?? [];
  if (rows.length === 0) return 0;
  const taskIds = rows.map((r) => r.id);

  const updRes = await supabase
    .from('tasks')
    .update({ assignee_id: toUserId })
    .in('id', taskIds);
  if (updRes.error) throw new Error(updRes.error.message);

  const events = taskIds.map((id) => ({
    task_id: id,
    type: 'reassigned' as const,
    actor_id: actorId,
    note: null as string | null,
  }));
  const evRes = await supabase.from('task_events').insert(events);
  if (evRes.error) throw new Error(evRes.error.message);

  return taskIds.length;
}

/**
 * Remove an employee from a file. Manager/Admin of the file's company (enforced
 * by the route). RULES:
 *   • LAST-PERSON GUARD — refuse if this user is the ONLY assignee (a file must
 *     always keep ≥1 person). Caller surfaces the "add another first" message.
 *   • FORCED REASSIGNMENT — if the person leaving has UNFINISHED (open +
 *     awaiting_approval) tasks on the file, a `reassignTo` is REQUIRED (who MUST
 *     already be on the file); those tasks are moved to them before the remove.
 *     Without one → 'reassign_required'. If they have no unfinished tasks,
 *     `reassignTo` is optional (and, if given, still validated).
 * `actorId` is the manager/admin performing the removal (recorded on the
 * 'reassigned' task_events).
 */
export async function removeFileAccess(input: {
  fileId: string;
  userId: string;
  actorId: string;
  reassignTo?: string | null;
}): Promise<RemoveAccessResult> {
  const { fileId, userId, actorId } = input;
  const reassignTo = input.reassignTo ?? null;
  const supabase = getSupabaseAdmin();

  const memberIds = await fileAccessUserIds(fileId);
  const memberSet = new Set(memberIds);

  if (!memberSet.has(userId)) return { ok: false, code: 'not_found' };
  // A file must always keep at least one assignee.
  if (memberIds.length <= 1) return { ok: false, code: 'last_person' };

  const unfinished = await countUnfinishedTasksOnFile(fileId, userId);

  // Validate any supplied replacement (must be on the file, and not the leaver).
  if (reassignTo != null) {
    if (reassignTo === userId || !memberSet.has(reassignTo)) {
      return { ok: false, code: 'bad_reassign' };
    }
  }

  if (unfinished > 0) {
    // The person still owns live work — a valid replacement is mandatory.
    if (reassignTo == null) return { ok: false, code: 'reassign_required' };
    await reassignOpenTasks(fileId, userId, reassignTo, actorId);
  }

  const delRes = await supabase
    .from('file_access')
    .delete()
    .eq('file_id', fileId)
    .eq('user_id', userId);
  if (delRes.error) throw new Error(delRes.error.message);

  return { ok: true };
}
