import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { workingSecondsBetween } from './workingTime';
import { isFileSection, type FileSection } from './fileColors';
import {
  fileColor,
  effectiveOverdueWorkingSeconds,
  type FileColor,
} from './colorEngine';
import {
  fetchUsersByIds,
  isFileMember,
  isCompanyManager,
  type AccessPerson,
} from './access';
import { leaveEndFor, todayIso } from './leave';

/** Color-step default (mirrors lib/platform/files.ts) when a company row nulls
 * the column. Echoed onto task file briefs so the client color engine matches
 * the server. (DEFAULT_WORKING_DAYS is already defined below and reused here.) */
const DEFAULT_DAYS_PER_STEP = 3;

/**
 * Tasks data-access layer (Phase 4).
 *
 * Pure data access over `tasks` + `task_events` using the service-role client.
 * AUTHORIZATION (who may call) is enforced by the API routes via the two-layer
 * model; this layer performs only DOMAIN validation (is this a legal assignee /
 * approver / state transition) and returns coded results, exactly like
 * lib/platform/access.ts. Company isolation is enforced by the routes resolving
 * the file's company before calling in.
 *
 * THE TIMER (spec §4.7):
 *   • create   → status open, assigned_at = now, last_resumed_at = now,
 *                accumulated_working_seconds = 0.
 *   • mark done→ FREEZE: accumulated += workingSecondsBetween(last_resumed_at,
 *                now), last_resumed_at = null, status awaiting_approval.
 *   • send back→ RESUME: last_resumed_at = now (accumulated kept), status open.
 *   • approve  → status approved (timer already frozen from the done step).
 * PostgREST embedding is avoided (tasks has three FKs to app_users); we fetch
 * rows then batch-resolve people / files / companies by id — the manual-join
 * pattern used across lib/platform.
 */

export type TaskStatus = 'open' | 'awaiting_approval' | 'approved';

/**
 * Statuses in which a task is NOT yet completed — still editable / actionable.
 * 'approved' is the ONLY completed (locked) status. These MUST be real values of
 * the Postgres `task_status` enum ('open' | 'awaiting_approval' | 'approved') —
 * this array is passed straight into `.in('status', …)` / `.eq('status', …)`
 * filters, and Postgres REJECTS the whole query with an invalid-enum-input error
 * if it ever sees a value the enum doesn't define. (Sending a task back is an
 * EVENT — task_event_type 'sent_back' — that returns the STATUS to 'open'; there
 * is no 'sent_back' status.) Typed as TaskStatus[] so a stray non-enum string
 * fails the build instead of silently reaching the DB. Single source of truth:
 * imported by the routes rather than redefined, so the editable/locked rule
 * stays in one place.
 */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['open', 'awaiting_approval'];

export type TaskEventType =
  | 'created'
  | 'marked_done'
  | 'approved'
  | 'sent_back'
  | 'reassigned';

export type TaskPerson = AccessPerson;

/** One history event on a task (newest-first in the API). */
export interface TaskEvent {
  id: string;
  type: TaskEventType;
  actor: TaskPerson | null;
  note: string | null;
  createdAt: string;
}

/** A task enriched for the UI (people resolved; optional event history). */
export interface Task {
  id: string;
  fileId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: TaskPerson | null;
  approver: TaskPerson | null;
  createdBy: TaskPerson | null;
  assignedAt: string;
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
  createdAt: string;
  /** The note from the most recent 'sent_back' event, if any (shown on the task). */
  lastSendBackNote: string | null;
  /**
   * The assignee's own completion comment — the note on the most recent
   * 'marked_done' event ("what did you do?"). Shown to the approver so they can
   * read it before approving or sending back. null when they left it empty.
   */
  lastDoneNote: string | null;
  /** When the work is due (migration #32). Null for a task with no deadline. */
  dueAt: string | null;
  /** Repeat interval in days, or null for a one-off task. */
  repeatEveryDays: number | null;
  /** True when this task must not drive its folder's colour. */
  excludedFromColor: boolean;
  /**
   * How long the work is expected to take (migration #33), or null when nobody
   * has estimated it. A task with no estimate adds NOTHING to a day's load on
   * the workload calendar — see lib/platform/workload.ts.
   */
  estimatedHours: number | null;
  /**
   * The day the work is PLANNED for, as a local 'YYYY-MM-DD' date (migration
   * #33) — distinct from `dueAt`, which is when it must be finished. null means
   * UNSCHEDULED: the task sits in the calendar's unscheduled pile until someone
   * drops it onto a day.
   */
  scheduledDate: string | null;
  /** Full history, newest-first — present on file-detail / employee views. */
  events?: TaskEvent[];
}

/** A brief of the file a task belongs to (for cross-file task lists). */
export interface TaskFileBrief {
  id: string;
  client: string;
  opponent: string;
  companyId: string;
  companyNameEn: string;
  companyNameAr: string;
  /**
   * The folder's Google Drive link — ACCESS-GATED. Present ONLY when the caller
   * this brief is built for has an ACTIVE access grant to the folder (a
   * file_access row). Omitted (null) otherwise, so the link never reaches a user
   * without a grant. Only populated when attachFiles() is given a
   * `driveLinkForUserId`; the manager overview readers leave it null.
   */
  driveLink: string | null;
  /**
   * The folder's SECTION + the company's color-ladder settings — echoed so the
   * CLIENT can reuse the shared color engine to show a per-task "time until the
   * next color" countdown (working-time only). Not secret.
   */
  section: FileSection;
  workingDays: number[];
  daysPerColorStep: number;
  /**
   * PER-VIEWER folder color, derived ONLY from the caller's OWN open tasks in
   * this folder (so each employee sees the folder in their own lateness color).
   * null when the caller has no open task here → the UI shows a neutral folder.
   * Populated only when attachFiles() is given `colorForAssigneeId` (the
   * tasks/mine path); the manager overview readers leave it null (they get the
   * aggregate color via the Files API instead).
   */
  color: FileColor | null;
}

/** A task plus its file brief (My Tasks / Employee Tasks / My Files). */
export interface TaskWithFile extends Task {
  file: TaskFileBrief;
}

/** Minimal task shape for route-level authorization / transitions. */
export interface TaskCore {
  id: string;
  fileId: string;
  title: string;
  assigneeId: string;
  approverId: string;
  createdBy: string;
  status: TaskStatus;
  assignedAt: string;
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
}

// ---- Raw row shapes (untyped PostgREST JSON; cast defensively) -------------

interface TaskRow {
  id: string;
  file_id: string;
  title: string;
  description: string | null;
  assignee_id: string;
  approver_id: string;
  created_by: string;
  status: TaskStatus;
  assigned_at: string;
  accumulated_working_seconds: number | string;
  last_resumed_at: string | null;
  created_at: string;
  /** Absent (undefined) until migration #32 has been applied. */
  due_at?: string | null;
  repeat_every_days?: number | null;
  excluded_from_color?: boolean | null;
  /** Absent (undefined) until migration #33 has been applied. */
  estimated_hours?: number | string | null;
  scheduled_date?: string | null;
}
interface TaskEventRow {
  id: string;
  task_id: string;
  type: TaskEventType;
  actor_id: string;
  note: string | null;
  created_at: string;
}
interface FileBriefRow {
  id: string;
  company_id: string;
  client: string;
  opponent: string;
  drive_link: string | null;
  section: string;
}
interface CompanyBriefRow {
  id: string;
  name_en: string;
  name_ar: string;
}
interface CompanySettingsRow {
  id: string;
  working_days: number[] | null;
  days_per_color_step: number | null;
}

const TASK_COLUMNS =
  'id, file_id, title, description, assignee_id, approver_id, created_by, status, assigned_at, accumulated_working_seconds, last_resumed_at, created_at';

/** Migration #32's deadline/repeat fields. */
const TASK_SCHEDULE_COLUMNS = 'due_at, repeat_every_days, excluded_from_color';

/** Migration #33's workload-planning fields. */
const TASK_PLANNING_COLUMNS = 'estimated_hours, scheduled_date';

/**
 * Null until probed. Selecting a column the database does not have fails the
 * WHOLE query, and this build ships before its migration runs, so the column
 * list has to be chosen from what actually exists.
 *
 * Probed ONCE per process with a zero-row select rather than retried at each of
 * the call sites below: one wasted round trip on first use, instead of a
 * fallback path duplicated eight times that only one of them would ever be
 * tested through.
 *
 * TWO INDEPENDENT FLAGS, one per migration. A database can be missing either,
 * both, or neither — during the deploy window for #33 the #32 columns are
 * already there — and a single flag would drop both groups whenever the newer
 * one was absent, silently regressing deadlines to reinstate them.
 */
let tasksHaveSchedule: boolean | null = null;
let tasksHavePlanning: boolean | null = null;

/**
 * Probe one column group once, latching the answer for the process. Any error
 * at all → assume absent: a transient failure costs one release of the extra
 * fields, not a broken task list.
 */
async function probeColumn(column: string): Promise<boolean> {
  const probe = await getSupabaseAdmin().from('tasks').select(column).limit(0);
  return !probe.error;
}

async function taskColumns(): Promise<string> {
  if (tasksHaveSchedule === null) {
    tasksHaveSchedule = await probeColumn('due_at');
  }
  if (tasksHavePlanning === null) {
    tasksHavePlanning = await probeColumn('scheduled_date');
  }
  return [
    TASK_COLUMNS,
    tasksHaveSchedule ? TASK_SCHEDULE_COLUMNS : null,
    tasksHavePlanning ? TASK_PLANNING_COLUMNS : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Whether this database carries migration #33 — the planning fields the
 * workload calendar writes. Callers that WRITE (rather than select) need the
 * same answer, and must not build an update naming a column that is not there
 * yet: the write would fail outright instead of degrading.
 */
export async function hasTaskPlanningColumns(): Promise<boolean> {
  if (tasksHavePlanning === null) {
    tasksHavePlanning = await probeColumn('scheduled_date');
  }
  return tasksHavePlanning;
}

/** accumulated_working_seconds is a bigint; PostgREST may return it as string. */
function toSeconds(v: number | string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * estimated_hours is a `numeric`, which PostgREST returns as a STRING to avoid
 * the precision loss a JSON number would introduce. It is also absent entirely
 * before migration #33.
 *
 * Anything that is not a usable positive number becomes null rather than 0:
 * "no estimate" and "an estimate of zero hours" must stay distinguishable,
 * because the calendar treats the first as unknown and would treat the second
 * as work that takes no time.
 */
function toHours(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function coreFromRow(row: TaskRow): TaskCore {
  return {
    id: row.id,
    fileId: row.file_id,
    title: row.title,
    assigneeId: row.assignee_id,
    approverId: row.approver_id,
    createdBy: row.created_by,
    status: row.status,
    assignedAt: row.assigned_at,
    accumulatedWorkingSeconds: toSeconds(row.accumulated_working_seconds),
    lastResumedAt: row.last_resumed_at,
  };
}

// ---- Company working days ---------------------------------------------------

const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];

/** A company's working_days (Sun–Thu default), used by the timer. */
async function getCompanyWorkingDays(companyId: string): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('companies')
    .select('working_days')
    .eq('id', companyId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { working_days: number[] | null } | null;
  const days = row?.working_days;
  return Array.isArray(days) && days.length > 0 ? days : DEFAULT_WORKING_DAYS;
}

/** The company_id a file belongs to, or null if the file is gone. */
async function companyIdForFile(fileId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('files')
    .select('company_id')
    .eq('id', fileId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { company_id: string } | null;
  return row?.company_id ?? null;
}

// ---- Enrichment -------------------------------------------------------------

/**
 * Resolve people (assignee/approver/creator + optional event actors) and
 * optionally attach event history, turning raw task rows into Task objects.
 */
async function enrichTasks(
  rows: TaskRow[],
  opts: { withEvents: boolean }
): Promise<Task[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabaseAdmin();

  // Optionally load events for these tasks (newest-first).
  const eventsByTask = new Map<string, TaskEventRow[]>();
  if (opts.withEvents) {
    const taskIds = rows.map((r) => r.id);
    const evRes = await supabase
      .from('task_events')
      .select('id, task_id, type, actor_id, note, created_at')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false });
    if (evRes.error) throw new Error(evRes.error.message);
    const evRows = (evRes.data as TaskEventRow[] | null) ?? [];
    for (const e of evRows) {
      const list = eventsByTask.get(e.task_id);
      if (list) list.push(e);
      else eventsByTask.set(e.task_id, [e]);
    }
  }

  // Batch-resolve every referenced person.
  const personIds = new Set<string>();
  for (const r of rows) {
    personIds.add(r.assignee_id);
    personIds.add(r.approver_id);
    personIds.add(r.created_by);
  }
  for (const list of eventsByTask.values()) {
    for (const e of list) personIds.add(e.actor_id);
  }
  const peopleById = await fetchUsersByIds(Array.from(personIds));

  return rows.map((r) => {
    const eventRows = eventsByTask.get(r.id) ?? [];
    const events: TaskEvent[] = eventRows.map((e) => ({
      id: e.id,
      type: e.type,
      actor: peopleById.get(e.actor_id) ?? null,
      note: e.note,
      createdAt: e.created_at,
    }));
    // Most recent send-back note (events are newest-first).
    const lastSendBack = eventRows.find((e) => e.type === 'sent_back');
    // Most recent completion comment written by the assignee (newest-first).
    const lastDone = eventRows.find((e) => e.type === 'marked_done' && e.note);
    const task: Task = {
      id: r.id,
      fileId: r.file_id,
      title: r.title,
      description: r.description,
      status: r.status,
      assignee: peopleById.get(r.assignee_id) ?? null,
      approver: peopleById.get(r.approver_id) ?? null,
      createdBy: peopleById.get(r.created_by) ?? null,
      assignedAt: r.assigned_at,
      accumulatedWorkingSeconds: toSeconds(r.accumulated_working_seconds),
      lastResumedAt: r.last_resumed_at,
      createdAt: r.created_at,
      lastSendBackNote: lastSendBack ? lastSendBack.note : null,
      lastDoneNote: lastDone ? lastDone.note : null,
      dueAt: r.due_at ?? null,
      repeatEveryDays: r.repeat_every_days ?? null,
      excludedFromColor: r.excluded_from_color === true,
      estimatedHours: toHours(r.estimated_hours),
      scheduledDate: r.scheduled_date ?? null,
    };
    if (opts.withEvents) task.events = events;
    return task;
  });
}

/**
 * Attach a file brief (+ company names) to each task.
 *
 * The folder's Drive link is ACCESS-GATED and off by default: it is included in
 * a brief ONLY when `opts.driveLinkForUserId` is given AND that user has an
 * ACTIVE access grant (a file_access row) to the file. For every other file, or
 * when no user is given, `driveLink` is null — so the link never reaches a
 * caller without a grant. The manager/approver overview readers omit the option
 * and therefore never carry the link through this path (they read it via the
 * admin/manager Files API instead).
 */
async function attachFiles(
  tasks: Task[],
  opts: { driveLinkForUserId?: string; colorForAssigneeId?: string } = {}
): Promise<TaskWithFile[]> {
  if (tasks.length === 0) return [];
  const supabase = getSupabaseAdmin();

  const fileIds = Array.from(new Set(tasks.map((t) => t.fileId)));
  const filesRes = await supabase
    .from('files')
    .select('id, company_id, client, opponent, drive_link, section')
    .in('id', fileIds);
  if (filesRes.error) throw new Error(filesRes.error.message);
  const fileRows = (filesRes.data as FileBriefRow[] | null) ?? [];
  const fileById = new Map<string, FileBriefRow>(
    fileRows.map((f) => [f.id, f])
  );

  const companyIds = Array.from(new Set(fileRows.map((f) => f.company_id)));
  const compById = new Map<string, CompanyBriefRow>();
  // Per-company color-ladder settings (working_days + days_per_color_step),
  // echoed onto each brief so the client can run the shared color engine.
  const settingsById = new Map<
    string,
    { workingDays: number[]; daysPerColorStep: number }
  >();
  if (companyIds.length > 0) {
    const compRes = await supabase
      .from('companies')
      .select('id, name_en, name_ar, working_days, days_per_color_step')
      .in('id', companyIds);
    if (compRes.error) throw new Error(compRes.error.message);
    const compRows =
      (compRes.data as (CompanyBriefRow & CompanySettingsRow)[] | null) ?? [];
    for (const c of compRows) {
      compById.set(c.id, c);
      settingsById.set(c.id, {
        workingDays:
          Array.isArray(c.working_days) && c.working_days.length > 0
            ? c.working_days
            : DEFAULT_WORKING_DAYS,
        daysPerColorStep:
          typeof c.days_per_color_step === 'number' && c.days_per_color_step > 0
            ? c.days_per_color_step
            : DEFAULT_DAYS_PER_STEP,
      });
    }
  }

  // Access gate: the set of files the target user is CURRENTLY on (an active
  // file_access grant). One query over the files in play. Absent gate → empty
  // set → no Drive links surface.
  const grantedFileIds = new Set<string>();
  if (opts.driveLinkForUserId && fileIds.length > 0) {
    const accRes = await supabase
      .from('file_access')
      .select('file_id')
      .eq('user_id', opts.driveLinkForUserId)
      .in('file_id', fileIds);
    if (accRes.error) throw new Error(accRes.error.message);
    for (const r of (accRes.data as { file_id: string }[] | null) ?? []) {
      grantedFileIds.add(r.file_id);
    }
  }

  // PER-VIEWER color: derive each folder's color from ONLY the viewer's OWN
  // open tasks in it, reusing the shared color engine (no fork). These tasks are
  // already the caller's (this path lists their own tasks), so nothing leaks.
  // A folder where the caller has NO open task is left OUT of the map → null
  // color → neutral folder in the UI.
  const colorByFile = new Map<string, FileColor>();
  if (opts.colorForAssigneeId) {
    const now = new Date();
    const ownOpenByFile = new Map<string, FileColorTask[]>();
    for (const t of tasks) {
      if (t.assignee?.userId !== opts.colorForAssigneeId) continue;
      if (t.status !== 'open' && t.status !== 'awaiting_approval') continue;
      const arr = ownOpenByFile.get(t.fileId) ?? [];
      arr.push({
        status: t.status,
        accumulatedWorkingSeconds: t.accumulatedWorkingSeconds,
        lastResumedAt: t.lastResumedAt,
        assignedAt: t.assignedAt,
      });
      ownOpenByFile.set(t.fileId, arr);
    }
    for (const f of fileRows) {
      const own = ownOpenByFile.get(f.id);
      if (!own || own.length === 0) continue; // no open task → neutral (null)
      const s = settingsById.get(f.company_id);
      colorByFile.set(
        f.id,
        fileColor(
          { section: isFileSection(f.section) ? f.section : 'potential' },
          own,
          {
            workingDays: s?.workingDays ?? DEFAULT_WORKING_DAYS,
            daysPerColorStep: s?.daysPerColorStep ?? DEFAULT_DAYS_PER_STEP,
          },
          now
        )
      );
    }
  }

  const out: TaskWithFile[] = [];
  for (const t of tasks) {
    const f = fileById.get(t.fileId);
    if (!f) continue; // file vanished — drop defensively
    const c = compById.get(f.company_id);
    const s = settingsById.get(f.company_id);
    out.push({
      ...t,
      file: {
        id: f.id,
        client: f.client,
        opponent: f.opponent,
        companyId: f.company_id,
        companyNameEn: c?.name_en ?? '',
        companyNameAr: c?.name_ar ?? '',
        // Only when the caller has an active grant to THIS file.
        driveLink: grantedFileIds.has(f.id) ? f.drive_link : null,
        section: isFileSection(f.section) ? f.section : 'potential',
        workingDays: s?.workingDays ?? DEFAULT_WORKING_DAYS,
        daysPerColorStep: s?.daysPerColorStep ?? DEFAULT_DAYS_PER_STEP,
        // Per-viewer color (own open tasks only); null when none / not requested.
        color: colorByFile.get(f.id) ?? null,
      },
    });
  }
  return out;
}

// ---- Reads ------------------------------------------------------------------

/** Minimal task by id (route authorization + transitions). */
export async function getTaskCore(id: string): Promise<TaskCore | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .eq('id', id)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as TaskRow | null;
  return row ? coreFromRow(row) : null;
}

/** All tasks on a file, newest-first, each WITH full event history. */
export async function listTasksForFile(fileId: string): Promise<Task[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as unknown as TaskRow[] | null) ?? [];
  return enrichTasks(rows, { withEvents: true });
}

/**
 * Tasks awaiting THIS approver's decision, across all companies: approver_id ==
 * approverId AND status == 'awaiting_approval'. Newest-first, with file briefs
 * and event history (so the UI can show the timeline / prior send-backs).
 */
export async function listAwaitingApprovalForApprover(
  approverId: string
): Promise<TaskWithFile[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .eq('approver_id', approverId)
    .eq('status', 'awaiting_approval')
    .order('assigned_at', { ascending: false });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as unknown as TaskRow[] | null) ?? [];
  const tasks = await enrichTasks(rows, { withEvents: true });
  return attachFiles(tasks);
}

/**
 * Tasks where THIS approver is named but the assignee hasn't marked them done
 * yet (status == 'open'), across all companies: approver_id == approverId AND
 * status == 'open'. Newest-first, with file briefs. Lets an approver see a
 * task exists the moment it's created rather than only once it reaches
 * 'awaiting_approval' — the in-app 'task_created' notification (see
 * lib/platform/alerts.ts) covers the same moment, but a list they can return
 * to beats a one-shot bell ping.
 *
 * EXCLUDES self-assigned tasks (assignee_id == approverId): those already
 * show under "My open tasks" — a manager who assigns work to themselves with
 * themselves as approver would otherwise see the same task listed twice.
 */
export async function listOpenForApprover(
  approverId: string
): Promise<TaskWithFile[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .eq('approver_id', approverId)
    .eq('status', 'open')
    .neq('assignee_id', approverId)
    .order('assigned_at', { ascending: false });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as unknown as TaskRow[] | null) ?? [];
  const tasks = await enrichTasks(rows, { withEvents: false });
  return attachFiles(tasks);
}

/**
 * All OPEN tasks in a company's files (the manager's Employee-Tasks overview).
 * Newest-first, with file briefs.
 */
export async function listOpenTasksForCompany(
  companyId: string
): Promise<TaskWithFile[]> {
  const supabase = getSupabaseAdmin();
  const filesRes = await supabase
    .from('files')
    .select('id')
    .eq('company_id', companyId);
  if (filesRes.error) throw new Error(filesRes.error.message);
  const fileIds = ((filesRes.data as { id: string }[] | null) ?? []).map(
    (f) => f.id
  );
  if (fileIds.length === 0) return [];

  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .in('file_id', fileIds)
    .eq('status', 'open')
    .order('assigned_at', { ascending: false });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as unknown as TaskRow[] | null) ?? [];
  const tasks = await enrichTasks(rows, { withEvents: false });
  return attachFiles(tasks);
}

/**
 * All tasks assigned to a user (their own work), newest-first, with file briefs
 * and event history (so the employee sees any send-back note). Used by the
 * employee "My Files" view and the manager's "My open tasks" self-task section.
 */
export async function listTasksForAssignee(
  assigneeId: string
): Promise<TaskWithFile[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(await taskColumns())
    .eq('assignee_id', assigneeId)
    .order('assigned_at', { ascending: false });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as unknown as TaskRow[] | null) ?? [];
  const tasks = await enrichTasks(rows, { withEvents: true });
  // These are the caller's OWN tasks, so (a) gate the Drive link on the
  // assignee's active grant, and (b) derive each folder's PER-VIEWER color from
  // this employee's own open tasks only.
  return attachFiles(tasks, {
    driveLinkForUserId: assigneeId,
    colorForAssigneeId: assigneeId,
  });
}

/**
 * Count of UNFINISHED (open + awaiting_approval) tasks per file, for the given
 * file ids — drives the folder badge. Files with no such tasks are absent from
 * the map (callers default to 0).
 */
export async function openTaskCountsByFile(
  fileIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique = Array.from(new Set(fileIds.filter((x) => !!x)));
  if (unique.length === 0) return counts;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select('file_id')
    .in('file_id', unique)
    .in('status', ['open', 'awaiting_approval']);
  if (res.error) {
    // DEPLOY SAFETY: this runs inside every file lookup/list. If the Phase-4
    // migration hasn't been applied yet the `tasks` table is missing (Postgres
    // 42P01) — degrade to zero badges rather than 500-ing the whole Files UI.
    if ((res.error as { code?: string }).code === '42P01') return counts;
    throw new Error(res.error.message);
  }
  const rows = (res.data as { file_id: string }[] | null) ?? [];
  for (const r of rows) {
    counts.set(r.file_id, (counts.get(r.file_id) ?? 0) + 1);
  }
  return counts;
}

/** Minimal per-task timer data the color engine needs (Phase 5). */
export interface FileColorTask {
  status: TaskStatus;
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
  assignedAt: string;
}

interface ColorTaskRow {
  file_id: string;
  status: TaskStatus;
  accumulated_working_seconds: number | string;
  last_resumed_at: string | null;
  assigned_at: string;
}

/**
 * UNFINISHED (open + awaiting_approval) tasks per file, carrying just the timer
 * fields the color engine reads, for the given file ids. Files with no such
 * tasks are absent from the map (callers default to []); the map length also
 * doubles as the folder badge count. Same 42P01 deploy-safety as
 * openTaskCountsByFile — degrade to an empty map if `tasks` isn't migrated yet.
 *
 * PER-VIEWER COLOR: pass `assigneeId` to restrict to ONE employee's own tasks,
 * so the folder color is derived from THAT viewer's lateness. Omit it (managers
 * / admins) to consider every employee's tasks — the aggregate worst case.
 */
/** Does this database have migration #32's excluded_from_color column? */
let tasksHaveColorExclusion = true;

export async function openTasksForColorByFile(
  fileIds: string[],
  assigneeId?: string
): Promise<Map<string, FileColorTask[]>> {
  const map = new Map<string, FileColorTask[]>();
  const unique = Array.from(new Set(fileIds.filter((x) => !!x)));
  if (unique.length === 0) return map;
  const supabase = getSupabaseAdmin();

  // EXCLUDED TASKS never reach the colour engine. The ladder exists to make
  // NEGLECTED work visible; a reminder deliberately set months ahead is not
  // neglected, and letting it march a folder to red teaches people to ignore
  // the one signal that should mean something. Filtered in SQL so an excluded
  // task costs nothing downstream.
  //
  // DEPLOY SAFETY: excluded_from_color arrives in migration #32. Asking for a
  // column the database does not have fails the whole query, so the flag
  // latches off on 42703 and every task counts — exactly the old behaviour.
  const runQuery = async (withExclusion: boolean) => {
    let query = supabase
      .from('tasks')
      .select(
        'file_id, status, accumulated_working_seconds, last_resumed_at, assigned_at'
      )
      .in('file_id', unique)
      .in('status', ['open', 'awaiting_approval']);
    if (withExclusion) query = query.not('excluded_from_color', 'is', true);
    if (assigneeId) query = query.eq('assignee_id', assigneeId);
    return query;
  };

  let res = await runQuery(tasksHaveColorExclusion);
  if (res.error?.code === '42703' && tasksHaveColorExclusion) {
    tasksHaveColorExclusion = false;
    res = await runQuery(false);
  }
  if (res.error) {
    if ((res.error as { code?: string }).code === '42P01') return map;
    throw new Error(res.error.message);
  }
  const rows = (res.data as ColorTaskRow[] | null) ?? [];
  for (const r of rows) {
    const item: FileColorTask = {
      status: r.status,
      accumulatedWorkingSeconds: toSeconds(r.accumulated_working_seconds),
      lastResumedAt: r.last_resumed_at,
      assignedAt: r.assigned_at,
    };
    const list = map.get(r.file_id);
    if (list) list.push(item);
    else map.set(r.file_id, [item]);
  }
  return map;
}

// ---- Create -----------------------------------------------------------------

/**
 * A person who is on booked leave cannot be given work — see
 * lib/platform/leave.ts. The refusal carries the last day of their leave so the
 * caller can say WHEN, rather than just "no".
 */
export type OnLeaveRefusal = {
  ok: false;
  code: 'assignee_on_leave';
  onLeaveUntil: string;
};

export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; code: 'bad_assignee' | 'bad_approver' | 'bad_input' }
  | OnLeaveRefusal;

/**
 * Null when this person may be given work today, otherwise the refusal to
 * return. Shared by create / reassign / edit so the three cannot drift.
 */
async function refuseIfOnLeave(
  assigneeId: string,
  companyId: string
): Promise<OnLeaveRefusal | null> {
  const onLeaveUntil = await leaveEndFor(assigneeId, companyId, todayIso());
  return onLeaveUntil ? { ok: false, code: 'assignee_on_leave', onLeaveUntil } : null;
}

/**
 * Create + assign a task on a file. DOMAIN validation (spec §6):
 *   • assignee must be a MEMBER of the file OR a MANAGER of the file's company
 *     (self-assign is therefore allowed for a manager).
 *   • approver must be a MANAGER of the file's company (may equal the
 *     creator/assignee — self-approval is legal).
 * Starts the timer (status open, assigned_at = now, last_resumed_at = now,
 * accumulated = 0) and writes a 'created' event. The caller (route) has already
 * verified the actor is a manager of the company.
 */
export async function createTask(input: {
  fileId: string;
  companyId: string;
  title: string;
  description: string | null;
  assigneeId: string;
  approverId: string;
  createdBy: string;
  /** Scheduling (migration #32). All optional; omitted = today's behaviour. */
  dueAt?: string | null;
  repeatEveryDays?: number | null;
  excludedFromColor?: boolean;
  /**
   * Workload planning (migration #33). Both optional. A task created without
   * them is UNSCHEDULED with no estimate — it appears in the calendar's
   * unscheduled pile, which is where a task nobody has planned belongs.
   */
  estimatedHours?: number | null;
  scheduledDate?: string | null;
}): Promise<CreateTaskResult> {
  const {
    fileId,
    companyId,
    title,
    description,
    assigneeId,
    approverId,
    createdBy,
  } = input;

  if (!title || !assigneeId || !approverId) {
    return { ok: false, code: 'bad_input' };
  }

  // Assignee: on the file, or a manager of the company.
  const assigneeOnFile = await isFileMember(fileId, assigneeId);
  if (!assigneeOnFile) {
    const assigneeIsManager = await isCompanyManager(assigneeId, companyId);
    if (!assigneeIsManager) return { ok: false, code: 'bad_assignee' };
  }

  // ON LEAVE — someone who is away cannot be given new work.
  const onLeave = await refuseIfOnLeave(assigneeId, companyId);
  if (onLeave) return onLeave;

  // Approver: must be a manager of the company.
  const approverIsManager = await isCompanyManager(approverId, companyId);
  if (!approverIsManager) return { ok: false, code: 'bad_approver' };

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const base = {
    file_id: fileId,
    title,
    description,
    assignee_id: assigneeId,
    approver_id: approverId,
    created_by: createdBy,
    status: 'open',
    assigned_at: nowIso,
    accumulated_working_seconds: 0,
    last_resumed_at: nowIso,
  };
  const scheduling = {
    due_at: input.dueAt ?? null,
    repeat_every_days: input.repeatEveryDays ?? null,
    excluded_from_color: input.excludedFromColor === true,
  };

  // The planning columns arrive one migration LATER than the scheduling ones,
  // so they are gated on their own (already-latched) probe rather than folded
  // into the retry below. Naming a column the database lacks fails the whole
  // insert, and the retry can only drop the #32 group as a unit — it would
  // discard a perfectly valid due date to work around a missing #33 column.
  const planning = (await hasTaskPlanningColumns())
    ? {
        estimated_hours: input.estimatedHours ?? null,
        scheduled_date: input.scheduledDate ?? null,
      }
    : {};

  // DEPLOY SAFETY: the scheduling columns arrive in migration #32. Inserting a
  // column the database lacks fails outright, so a rejected insert is retried
  // WITHOUT them — the task is still created, just without a schedule, which
  // is what every task was before this existed.
  let insRes = await supabase
    .from('tasks')
    .insert({ ...base, ...scheduling, ...planning })
    .select(await taskColumns())
    .single();
  if (insRes.error && (insRes.error as { code?: string }).code === '42703') {
    insRes = await supabase
      .from('tasks')
      .insert({ ...base, ...planning })
      .select(await taskColumns())
      .single();
  }
  if (insRes.error) throw new Error(insRes.error.message);
  const row = insRes.data as unknown as TaskRow;

  const evRes = await supabase.from('task_events').insert({
    task_id: row.id,
    type: 'created',
    actor_id: createdBy,
    note: null,
  });
  if (evRes.error) throw new Error(evRes.error.message);

  // REACTIVATION (spec §7.2): adding a task to an EXPIRED file returns it to
  // active status. Color is derived, so no color column changes — only the
  // section flips (and only when it was expired). Guarded on section='expired'
  // so a task on a potential/active file leaves the section untouched.
  const reactRes = await supabase
    .from('files')
    .update({ section: 'active' })
    .eq('id', fileId)
    .eq('section', 'expired');
  if (reactRes.error) throw new Error(reactRes.error.message);

  const [task] = await enrichTasks([row], { withEvents: true });
  // enrichTasks always returns one element for a one-row input.
  if (!task) throw new Error('Task enrichment failed after create.');
  return { ok: true, task };
}

// ---- Transitions ------------------------------------------------------------

export type TransitionResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'forbidden' | 'bad_state' | 'bad_input' };

/**
 * Assignee marks a task done. Only the assignee (checked by the route AND here)
 * may do so, and only from 'open'. FREEZES the timer: accumulated += the working
 * seconds elapsed since last_resumed_at (or assigned_at as a fallback), then
 * last_resumed_at = null and status = awaiting_approval. Writes 'marked_done'
 * carrying the assignee's OPTIONAL completion comment (`note`) — what they did —
 * which the approver reads on the awaiting-approval card.
 */
export async function markTaskDone(
  taskId: string,
  callerId: string,
  note?: string | null
): Promise<TransitionResult> {
  const task = await getTaskCore(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (task.assigneeId !== callerId) return { ok: false, code: 'forbidden' };
  if (task.status !== 'open') return { ok: false, code: 'bad_state' };

  // OPTIONAL comment — empty/absent stays null, exactly as before.
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  const doneNote = trimmedNote ? trimmedNote.slice(0, 2000) : null;

  const companyId = await companyIdForFile(task.fileId);
  const workingDays = companyId
    ? await getCompanyWorkingDays(companyId)
    : DEFAULT_WORKING_DAYS;

  const resumedFrom = task.lastResumedAt ?? task.assignedAt;
  const now = new Date();
  const elapsed = workingSecondsBetween(new Date(resumedFrom), now, workingDays);
  const newAccumulated = task.accumulatedWorkingSeconds + elapsed;

  const supabase = getSupabaseAdmin();
  const updRes = await supabase
    .from('tasks')
    .update({
      status: 'awaiting_approval',
      accumulated_working_seconds: newAccumulated,
      last_resumed_at: null,
    })
    .eq('id', taskId)
    .eq('status', 'open') // guard against a concurrent transition
    // …and read back whether the guard actually claimed the row. Without this
    // a second mark-done wrote a second 'marked_done' event and recomputed
    // accumulated_working_seconds from a stale read.
    .select('id')
    .maybeSingle();
  if (updRes.error) throw new Error(updRes.error.message);
  if (!updRes.data) return { ok: false, code: 'bad_state' };

  const evRes = await supabase.from('task_events').insert({
    task_id: taskId,
    type: 'marked_done',
    actor_id: callerId,
    // The assignee's optional completion comment ("what did you do?"). Stored on
    // the event itself so it shows in the task history the approver reads.
    note: doneNote,
  });
  if (evRes.error) throw new Error(evRes.error.message);

  return { ok: true };
}

/**
 * Approve a task → status approved. Authorization (named approver OR admin) is
 * enforced by the route; here we only require it be awaiting_approval. The timer
 * was already frozen at the done step, so nothing changes about the seconds.
 * Writes 'approved'.
 */
/**
 * If `taskId` carries a repeat interval, create the next occurrence.
 *
 * The successor is a fresh OPEN task with the same title, description,
 * assignee, approver and interval, due `repeat_every_days` after the one just
 * approved — chained from the previous DUE date rather than from "now", so a
 * monthly follow-up approved three days late does not permanently drift three
 * days later every cycle.
 *
 * Deliberately does NOT go through createTask: the domain checks there
 * (assignee still on the file, not on leave) would refuse to carry a schedule
 * forward for someone who happens to be away today, silently ending the
 * recurrence. The chain is preserved and the next occurrence can be reassigned
 * like any other task.
 */
async function spawnNextOccurrence(taskId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('tasks')
    .select(
      'file_id, title, description, assignee_id, approver_id, created_by, due_at, repeat_every_days, excluded_from_color'
    )
    .eq('id', taskId)
    .maybeSingle();
  // Pre-migration-#32 the columns do not exist; nothing repeats, which is the
  // behaviour that existed before recurrence did.
  if (res.error) {
    if ((res.error as { code?: string }).code === '42703') return;
    throw new Error(res.error.message);
  }
  const row = res.data as {
    file_id: string;
    title: string;
    description: string | null;
    assignee_id: string;
    approver_id: string;
    created_by: string;
    due_at: string | null;
    repeat_every_days: number | null;
    excluded_from_color: boolean | null;
  } | null;
  if (!row || !row.repeat_every_days || row.repeat_every_days <= 0) return;

  // Chain from the previous due date when there was one, else from now.
  const anchor = row.due_at ? new Date(row.due_at) : new Date();
  const nextDue = new Date(anchor.getTime());
  nextDue.setUTCDate(nextDue.getUTCDate() + row.repeat_every_days);

  const nowIso = new Date().toISOString();
  const ins = await supabase
    .from('tasks')
    .insert({
      file_id: row.file_id,
      title: row.title,
      description: row.description,
      assignee_id: row.assignee_id,
      approver_id: row.approver_id,
      created_by: row.created_by,
      status: 'open',
      assigned_at: nowIso,
      accumulated_working_seconds: 0,
      last_resumed_at: nowIso,
      due_at: nextDue.toISOString(),
      repeat_every_days: row.repeat_every_days,
      excluded_from_color: row.excluded_from_color === true,
    })
    .select('id')
    .single();
  if (ins.error) throw new Error(ins.error.message);

  const ev = await supabase.from('task_events').insert({
    task_id: (ins.data as { id: string }).id,
    type: 'created',
    actor_id: row.created_by,
    note: 'Recurring follow-up',
  });
  if (ev.error) console.error('Recurring follow-up event failed:', ev.error.message);
}

export async function approveTask(
  taskId: string,
  actorId: string
): Promise<TransitionResult> {
  const task = await getTaskCore(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (task.status !== 'awaiting_approval') {
    return { ok: false, code: 'bad_state' };
  }

  const supabase = getSupabaseAdmin();
  /*
    CLAIM THE ROW, THEN CHECK THAT WE GOT IT.

    `.eq('status', 'awaiting_approval')` makes this a compare-and-swap, but
    without a chained `.select()` supabase-js reports no row count — so an
    update that matched NOTHING, because a concurrent request already approved
    this task, was indistinguishable from one that matched. The loser carried
    on, wrote its own task_events row, and returned ok.

    That is not merely a cosmetic double-200. `spawnNextOccurrence` below has
    no idempotency guard, so a double-submitted approval of a RECURRING task
    created two successors — and each carries `repeat_every_days` forward, so
    the chain forks permanently and every cycle after that spawns two.

    The pattern is already in this codebase, done correctly, in
    lib/platform/approvals.ts:345 — this brings the task transitions into line
    with it. Bailing here, BEFORE the recurrence spawn, is the whole point.
  */
  const updRes = await supabase
    .from('tasks')
    .update({ status: 'approved' })
    .eq('id', taskId)
    .eq('status', 'awaiting_approval')
    .select('id')
    .maybeSingle();
  if (updRes.error) throw new Error(updRes.error.message);
  if (!updRes.data) return { ok: false, code: 'bad_state' };

  // RECURRENCE. A repeating task spawns its successor at APPROVAL, not at
  // "done": until a manager signs it off the work is not finished, and issuing
  // the next occurrence early would leave two open copies of the same job.
  // Best-effort — a failure here must not undo an approval that has already
  // been recorded, so it is logged rather than thrown.
  try {
    await spawnNextOccurrence(taskId);
  } catch (err) {
    console.error('Recurring task follow-up failed:', err);
  }

  const evRes = await supabase.from('task_events').insert({
    task_id: taskId,
    type: 'approved',
    actor_id: actorId,
    note: null,
  });
  if (evRes.error) throw new Error(evRes.error.message);

  // Phase 7: closing a task resets its alert-dedup state so that if the file is
  // ever reactivated and goes overdue again it can alert afresh. Best-effort and
  // deploy-safe — if the last_alert_level column isn't migrated yet (42703), we
  // ignore it rather than failing the approval.
  try {
    const clearRes = await supabase
      .from('tasks')
      .update({ last_alert_level: null })
      .eq('id', taskId);
    if (
      clearRes.error &&
      (clearRes.error as { code?: string }).code !== '42703'
    ) {
      console.error('Clear last_alert_level failed:', clearRes.error.message);
    }
  } catch (err) {
    console.error('Clear last_alert_level threw:', err);
  }

  return { ok: true };
}

/**
 * Send a task back → status open, RESUME the timer (last_resumed_at = now,
 * accumulated kept — NOT reset). Authorization (named approver OR admin) is
 * enforced by the route; here we require awaiting_approval and a non-empty note.
 * Writes 'sent_back' with the note (shown on the task).
 */
export async function sendBackTask(
  taskId: string,
  actorId: string,
  note: string
): Promise<TransitionResult> {
  const trimmed = (note ?? '').trim();
  if (!trimmed) return { ok: false, code: 'bad_input' };

  const task = await getTaskCore(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (task.status !== 'awaiting_approval') {
    return { ok: false, code: 'bad_state' };
  }

  const supabase = getSupabaseAdmin();
  // Claimed, then checked — see approveTask. A send-back that lost to a
  // concurrent approval must not also write a 'sent_back' event, or the task
  // history shows both happening to the same task.
  const updRes = await supabase
    .from('tasks')
    .update({ status: 'open', last_resumed_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('status', 'awaiting_approval')
    .select('id')
    .maybeSingle();
  if (updRes.error) throw new Error(updRes.error.message);
  if (!updRes.data) return { ok: false, code: 'bad_state' };

  const evRes = await supabase.from('task_events').insert({
    task_id: taskId,
    type: 'sent_back',
    actor_id: actorId,
    note: trimmed,
  });
  if (evRes.error) throw new Error(evRes.error.message);

  return { ok: true };
}

// ---- Manager edit / reassign / delete ---------------------------------------

/**
 * Reassign a task to a new assignee. The new assignee must be a MEMBER of the
 * file or a MANAGER of the company (same rule as create). Writes 'reassigned'.
 * Authorization (manager/admin of the company) is enforced by the route.
 */
export async function reassignTask(input: {
  taskId: string;
  fileId: string;
  companyId: string;
  newAssigneeId: string;
  actorId: string;
}): Promise<TransitionResult | OnLeaveRefusal> {
  const { taskId, fileId, companyId, newAssigneeId, actorId } = input;
  if (!newAssigneeId) return { ok: false, code: 'bad_input' };

  const onFile = await isFileMember(fileId, newAssigneeId);
  if (!onFile) {
    const isManager = await isCompanyManager(newAssigneeId, companyId);
    if (!isManager) return { ok: false, code: 'bad_input' };
  }

  // ON LEAVE — same rule as create: work cannot be handed to someone away.
  const onLeave = await refuseIfOnLeave(newAssigneeId, companyId);
  if (onLeave) return onLeave;

  const supabase = getSupabaseAdmin();
  const updRes = await supabase
    .from('tasks')
    .update({ assignee_id: newAssigneeId })
    .eq('id', taskId);
  if (updRes.error) throw new Error(updRes.error.message);

  const evRes = await supabase.from('task_events').insert({
    task_id: taskId,
    type: 'reassigned',
    actor_id: actorId,
    note: null,
  });
  if (evRes.error) throw new Error(evRes.error.message);

  return { ok: true };
}

export type EditTaskResult =
  | { ok: true }
  | {
      ok: false;
      code: 'not_found' | 'locked' | 'bad_assignee' | 'bad_approver' | 'bad_input';
    }
  | OnLeaveRefusal;

/**
 * MANAGER EDIT of a NOT-YET-COMPLETED task. Editable fields: title, description,
 * assignee, approver. Company_id and the file are NEVER touched (isolation). The
 * TIMER (assigned_at / accumulated / last_resumed_at) is deliberately left
 * untouched, so the derived overdue color + countdown continue from the same
 * anchor; a reassignment simply hands the accrued lateness to the new assignee
 * (matching reassignTask). Rules — same domain checks as create:
 *   • assignee must be a MEMBER of the file OR a MANAGER of the company.
 *   • approver must be a MANAGER of the company.
 * A completed ('approved') task is LOCKED → 'locked'. Authorization (manager/
 * admin of the company) is enforced by the route. Writes a 'reassigned' event
 * when the assignee changes (the only edit the task_event_type enum can record;
 * other field edits have no dedicated event type).
 */
export async function editTask(input: {
  taskId: string;
  fileId: string;
  companyId: string;
  actorId: string;
  title?: string;
  description?: string | null;
  assigneeId?: string;
  approverId?: string;
}): Promise<EditTaskResult> {
  const task = await getTaskCore(input.taskId);
  if (!task) return { ok: false, code: 'not_found' };
  // LOCK once completed. 'approved' is the completed status; anything in the
  // active set stays editable.
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
    return { ok: false, code: 'locked' };
  }

  const update: Record<string, unknown> = {};
  let assigneeChanged = false;

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { ok: false, code: 'bad_input' };
    update.title = title;
  }
  if (input.description !== undefined) {
    const d =
      typeof input.description === 'string' ? input.description.trim() : '';
    update.description = d.length > 0 ? d : null;
  }
  if (input.approverId !== undefined) {
    if (!input.approverId) return { ok: false, code: 'bad_input' };
    const approverIsManager = await isCompanyManager(
      input.approverId,
      input.companyId
    );
    if (!approverIsManager) return { ok: false, code: 'bad_approver' };
    update.approver_id = input.approverId;
  }
  if (input.assigneeId !== undefined) {
    if (!input.assigneeId) return { ok: false, code: 'bad_input' };
    if (input.assigneeId !== task.assigneeId) {
      const onFile = await isFileMember(input.fileId, input.assigneeId);
      if (!onFile) {
        const isManager = await isCompanyManager(
          input.assigneeId,
          input.companyId
        );
        if (!isManager) return { ok: false, code: 'bad_assignee' };
      }
      // ON LEAVE — only checked when the assignee actually changes, so an edit
      // to the title of a task already held by someone away still goes through.
      const onLeave = await refuseIfOnLeave(input.assigneeId, input.companyId);
      if (onLeave) return onLeave;
      update.assignee_id = input.assigneeId;
      assigneeChanged = true;
    }
  }

  if (Object.keys(update).length === 0) return { ok: true }; // nothing changed

  const supabase = getSupabaseAdmin();
  const updRes = await supabase
    .from('tasks')
    .update(update)
    .eq('id', input.taskId)
    // Guard against a concurrent approval between the read and the write: a task
    // that just became 'approved' must not be edited.
    .in('status', ACTIVE_TASK_STATUSES);
  if (updRes.error) throw new Error(updRes.error.message);

  if (assigneeChanged) {
    const evRes = await supabase.from('task_events').insert({
      task_id: input.taskId,
      type: 'reassigned',
      actor_id: input.actorId,
      note: null,
    });
    if (evRes.error) throw new Error(evRes.error.message);
  }

  return { ok: true };
}

export type PlanTaskResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'locked' | 'bad_input' | 'unavailable' };

/** 'YYYY-MM-DD' — a plain calendar day, with no timezone attached. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a real calendar day, and not merely a well-shaped string? '2026-02-31'
 * matches the pattern above and is not a date; Postgres would reject it, but
 * with a driver-level error rather than the 400 the caller deserves.
 */
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * PLAN a task onto a day, and/or record how long it is expected to take — the
 * write behind dragging a task on the workload calendar and behind the hours
 * field on the task card.
 *
 * Deliberately NOT part of editTask. Editing a task is a consequential act
 * (retitling it, handing it to someone else) gated behind 'tasks.edit' and, for
 * a granted employee, an approval that a manager may have to sign off. Moving a
 * task from Tuesday to Wednesday is not that: it is the ordinary rearranging of
 * one's own week, it happens by the dozen in a single sitting, and routing it
 * through the approval queue would bury the queue in noise until nobody read
 * it. So it is a separate, narrow write that touches two columns and nothing
 * else — it cannot change who does the work, what the work is, or when it is
 * due, which is what the heavier gate exists to protect.
 *
 * BOTH FIELDS ARE OPTIONAL AND NULLABLE, and null is a real value here, not a
 * synonym for "leave it alone": passing scheduledDate: null is how a task is
 * dragged back OUT of the calendar into the unscheduled pile, and
 * estimatedHours: null is how a wrong estimate is withdrawn. "Leave it alone"
 * is `undefined` — the field simply absent.
 *
 * A COMPLETED task is locked, exactly as it is for editTask: its day has
 * already happened, and re-planning it would move finished work around the
 * calendar and change what last month's load looked like after the fact.
 *
 * Authorization is the ROUTE's job (see app/api/tasks/[id]/plan/route.ts).
 */
export async function planTask(input: {
  taskId: string;
  scheduledDate?: string | null;
  estimatedHours?: number | null;
}): Promise<PlanTaskResult> {
  if (input.scheduledDate === undefined && input.estimatedHours === undefined) {
    return { ok: false, code: 'bad_input' };
  }

  // Without migration #33 there is nowhere to put either value. Reported as
  // its own code so the route can answer "not available yet" rather than
  // claiming success and silently dropping the plan on the floor.
  if (!(await hasTaskPlanningColumns())) return { ok: false, code: 'unavailable' };

  const task = await getTaskCore(input.taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
    return { ok: false, code: 'locked' };
  }

  const update: Record<string, unknown> = {};

  if (input.scheduledDate !== undefined) {
    if (input.scheduledDate === null) {
      update.scheduled_date = null;
    } else {
      const day = input.scheduledDate.trim();
      if (!DATE_ONLY.test(day) || !isRealDate(day)) {
        return { ok: false, code: 'bad_input' };
      }
      update.scheduled_date = day;
    }
  }

  if (input.estimatedHours !== undefined) {
    if (input.estimatedHours === null) {
      update.estimated_hours = null;
    } else {
      const h = input.estimatedHours;
      // Mirrors the check constraint in migration #33, so a bad number is a
      // 400 from here rather than a 500 out of the database.
      if (!Number.isFinite(h) || h <= 0 || h > 999.99) {
        return { ok: false, code: 'bad_input' };
      }
      // Two decimals — the column's own scale. Rounding here rather than
      // letting Postgres do it keeps what the API returns identical to what
      // the next read will produce.
      update.estimated_hours = Math.round(h * 100) / 100;
    }
  }

  const supabase = getSupabaseAdmin();
  const updRes = await supabase
    .from('tasks')
    .update(update)
    .eq('id', input.taskId)
    // Same concurrency guard as editTask: a task approved between the read
    // above and this write must not be re-planned.
    .in('status', ACTIVE_TASK_STATUSES);
  if (updRes.error) throw new Error(updRes.error.message);

  return { ok: true };
}

export type PushBackResult =
  | { ok: true; grantedDays: number }
  | { ok: false; code: 'not_found' | 'bad_state' | 'bad_input' };

/** A working day, in seconds — the unit the colour ladder counts in. */
const PUSH_BACK_SECONDS_PER_DAY = 86400;

/**
 * PUSH A TASK'S COLOUR BACK A STEP and give it `days` working days before it
 * climbs again.
 *
 * WHY THIS IS ARITHMETIC ON THE CLOCK, NOT A STATUS FIELD
 *   Nothing stores "this task is red". The folder's colour is derived, per
 *   render, from how much working time its open tasks have accrued
 *   (lib/platform/colorEngine.ts: steps = floor(overdueDays / daysPerStep)).
 *   So the only way to move a task back a step is to rewind its own clock.
 *
 * WHAT IT SETS
 *   The task is placed exactly `days` working days BELOW the boundary of its
 *   next step. If it currently sits at step N, its accrued time becomes
 *   (N * daysPerStep - days) days, and the timer is restarted from now. The
 *   number therefore means precisely what the manager typed: that many working
 *   days until the colour advances again, whatever the company's step size is.
 *
 *   Asking for more days than the task has climbed drops it further than one
 *   step — floored at zero, its section's starting colour. That is the honest
 *   reading of "give it N days", not a bug to clamp away.
 *
 * OPEN or AWAITING APPROVAL. It used to be open-only, on the reasoning that a
 * submitted task has a frozen clock and is the approver's problem rather than a
 * lateness problem. That holds right up until the approver sends it back: the
 * task resumes from whatever it had accrued, so a submitted task that has been
 * sitting a long time comes back already red through no fault of the person who
 * submitted it on time. Granting days while it is submitted is exactly how you
 * prevent that.
 *
 * The difference is what happens to the CLOCK. An open task's timer is
 * restarted from now, so the granted days run from the push-back. A submitted
 * task's timer stays frozen — restarting it would quietly begin charging
 * lateness for time the approver is taking.
 */
export async function pushBackTask(input: {
  taskId: string;
  days: number;
  actorId: string;
}): Promise<PushBackResult> {
  const { taskId, days, actorId } = input;
  if (!Number.isFinite(days) || days <= 0) return { ok: false, code: 'bad_input' };

  const task = await getTaskCore(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (task.status !== 'open' && task.status !== 'awaiting_approval') {
    return { ok: false, code: 'bad_state' };
  }
  const isSubmitted = task.status === 'awaiting_approval';

  const supabase = getSupabaseAdmin();
  const fileRes = await supabase
    .from('files')
    .select('company_id')
    .eq('id', task.fileId)
    .maybeSingle();
  if (fileRes.error) throw new Error(fileRes.error.message);
  const companyId = (fileRes.data as { company_id: string } | null)?.company_id;
  if (!companyId) return { ok: false, code: 'not_found' };

  const compRes = await supabase
    .from('companies')
    .select('working_days, days_per_color_step')
    .eq('id', companyId)
    .maybeSingle();
  if (compRes.error) throw new Error(compRes.error.message);
  const comp = compRes.data as {
    working_days: number[] | null;
    days_per_color_step: number | null;
  } | null;
  const workingDays =
    Array.isArray(comp?.working_days) && comp!.working_days!.length > 0
      ? comp!.working_days!
      : DEFAULT_WORKING_DAYS;
  const daysPerStep =
    typeof comp?.days_per_color_step === 'number' && comp!.days_per_color_step! > 0
      ? comp!.days_per_color_step!
      : DEFAULT_DAYS_PER_STEP;

  const now = new Date();
  const accruedSeconds = effectiveOverdueWorkingSeconds(
    {
      status: task.status,
      accumulatedWorkingSeconds: task.accumulatedWorkingSeconds,
      lastResumedAt: task.lastResumedAt,
      assignedAt: task.assignedAt,
    },
    now,
    workingDays
  );
  const currentStep = Math.floor(
    accruedSeconds / PUSH_BACK_SECONDS_PER_DAY / daysPerStep
  );

  // The boundary of the step it is currently on, minus the granted days.
  const targetDays = Math.max(0, currentStep * daysPerStep - days);
  const targetSeconds = Math.round(targetDays * PUSH_BACK_SECONDS_PER_DAY);

  const upd = await supabase
    .from('tasks')
    .update({
      accumulated_working_seconds: targetSeconds,
      // An open task's clock restarts from now, so the granted days run from
      // the push-back. A submitted task's stays frozen (null): restarting it
      // would start charging lateness for the approver's own review time.
      ...(isSubmitted ? {} : { last_resumed_at: now.toISOString() }),
    })
    .eq('id', taskId)
    .eq('status', task.status);
  if (upd.error) throw new Error(upd.error.message);

  const ev = await supabase.from('task_events').insert({
    task_id: taskId,
    type: 'pushed_back',
    actor_id: actorId,
    note: String(days),
  });
  if (ev.error) throw new Error(ev.error.message);

  return { ok: true, grantedDays: days };
}

/** Delete a task (cascades its events). Authorization enforced by the route. */
export async function deleteTask(taskId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const delRes = await supabase.from('tasks').delete().eq('id', taskId);
  if (delRes.error) throw new Error(delRes.error.message);
}
