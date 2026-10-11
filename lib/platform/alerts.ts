import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { fileColor, type ColorCompanySettings } from './colorEngine';
import { isFileSection, type FileSection } from './fileColors';
import { listCompanyManagers } from './access';
import { insertNotifications, type NewNotification } from './notifications';
import { listTasksForAssignee } from './tasks';
import { sendTelegram } from './telegram';
import { companyMembersWithCapability } from './capabilityGrants';

/**
 * Alert engine (Phase 7) — EVALUATED ON READ (no reliable cron here).
 *
 * evaluateAlerts(companyId) walks every OPEN task in the company, derives each
 * task's current overdue alert level via the color engine, and fires an in-app
 * notification (and, for RED, an optional Telegram push) ONLY on a NEW upward
 * transition — deduplicated by tasks.last_alert_level:
 *
 *   • null → 'warn'      (task reaches orange) → notify the RESPONSIBLE EMPLOYEE
 *                          (assignee) + the task's APPROVER — the manager
 *                          accountable for signing it off, not whoever
 *                          happened to create it (an employee explicitly
 *                          granted 'tasks.create'/can_create_task may be the
 *                          creator and is not necessarily a manager, so
 *                          created_by is not a safe stand-in for "a manager
 *                          who should know").
 *   • (null|'warn') → 'critical' (task reaches red) → notify ALL MANAGERS of the
 *                          company, and push Telegram if it is enabled+configured.
 *
 * EVERYTHING IS OPTIONAL: if the company's alerts_enabled is false, this does
 * nothing at all. It is always called best-effort (wrapped by the caller in
 * try/catch) so it can never break the page. last_alert_level is reset to null
 * when a task is approved (see approveTask) so a reactivated / again-overdue
 * task can alert afresh.
 */

const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];
const DEFAULT_DAYS_PER_STEP = 3;

interface CompanyAlertRow {
  name_en: string | null;
  name_ar: string | null;
  alerts_enabled: boolean | null;
  telegram_enabled: boolean | null;
  working_days: number[] | null;
  days_per_color_step: number | null;
}

interface FileBriefRow {
  id: string;
  section: string;
  client: string;
  opponent: string;
}

interface OpenTaskRow {
  id: string;
  file_id: string;
  title: string;
  assignee_id: string;
  approver_id: string;
  status: 'open' | 'awaiting_approval' | 'approved';
  accumulated_working_seconds: number | string;
  last_resumed_at: string | null;
  assigned_at: string;
  last_alert_level: string | null;
}

function isMissingColumnOrTable(err: { code?: string } | null): boolean {
  const code = err?.code;
  return code === '42P01' || code === '42703';
}

function toSeconds(v: number | string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function fileLabel(client: string, opponent: string): string {
  return `${client} vs ${opponent}`;
}
function fileLabelAr(client: string, opponent: string): string {
  return `${client} ضد ${opponent}`;
}

/**
 * Evaluate + fire alerts for one company. Safe to call on every Files/overview
 * load: it is a no-op when alerts are disabled or the migration is not yet
 * applied, and only writes when a task crosses a NEW threshold.
 */
/**
 * One evaluation per company at a time.
 *
 * evaluateAlerts de-duplicates on tasks.last_alert_level, but that is a
 * read-then-write with the notification insert and the Telegram push happening
 * in between: concurrent runs all observe last_alert_level = null, so each one
 * independently notifies every manager and posts to Telegram. Since any member
 * can trigger a run (POST .../alerts/evaluate) and every Files list triggers one
 * implicitly, N parallel requests meant N copies of every alert.
 *
 * Callers that arrive while a run is in flight now join it instead of starting
 * another. Per-process only — a second replica can still overlap — but it
 * removes the amplification an individual user can cause on demand.
 */
const inFlight = new Map<string, Promise<void>>();

export async function evaluateAlerts(companyId: string): Promise<void> {
  if (!companyId) return;
  const existing = inFlight.get(companyId);
  if (existing) return existing;

  const run = runEvaluateAlerts(companyId).finally(() => {
    inFlight.delete(companyId);
  });
  inFlight.set(companyId, run);
  return run;
}

async function runEvaluateAlerts(companyId: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  // 1) Company settings + master switch. If the Phase-7 columns aren't migrated
  //    (42703) or the row is missing, degrade to a no-op.
  const compRes = await supabase
    .from('companies')
    .select(
      'name_en, name_ar, alerts_enabled, telegram_enabled, working_days, days_per_color_step'
    )
    .eq('id', companyId)
    .maybeSingle();
  if (compRes.error) return; // includes 42703 (migration not applied yet)
  const comp = compRes.data as CompanyAlertRow | null;
  if (!comp) return;
  if (comp.alerts_enabled === false) return; // alerts OFF for this company

  const settings: ColorCompanySettings = {
    workingDays:
      Array.isArray(comp.working_days) && comp.working_days.length > 0
        ? comp.working_days
        : DEFAULT_WORKING_DAYS,
    daysPerColorStep:
      typeof comp.days_per_color_step === 'number' &&
      comp.days_per_color_step > 0
        ? comp.days_per_color_step
        : DEFAULT_DAYS_PER_STEP,
  };
  const companyName = comp.name_en || comp.name_ar || '';

  // 2) Files in this company (for section ladder + client/opponent labels).
  const filesRes = await supabase
    .from('files')
    .select('id, section, client, opponent')
    .eq('company_id', companyId);
  if (filesRes.error) return;
  const fileRows = (filesRes.data as FileBriefRow[] | null) ?? [];
  if (fileRows.length === 0) return;
  const fileById = new Map<string, FileBriefRow>(
    fileRows.map((f) => [f.id, f])
  );
  const fileIds = fileRows.map((f) => f.id);

  // 3) OPEN tasks in those files, with dedup state + timer fields.
  const tasksRes = await supabase
    .from('tasks')
    .select(
      'id, file_id, title, assignee_id, approver_id, status, accumulated_working_seconds, last_resumed_at, assigned_at, last_alert_level'
    )
    .in('file_id', fileIds)
    .eq('status', 'open');
  if (tasksRes.error) {
    // Missing table/column → migration not applied; degrade silently.
    if (isMissingColumnOrTable(tasksRes.error as { code?: string })) return;
    return;
  }
  const taskRows = (tasksRes.data as OpenTaskRow[] | null) ?? [];
  if (taskRows.length === 0) return;

  const now = new Date();
  const notifications: NewNotification[] = [];
  const warnTaskIds: string[] = [];
  const criticalTaskIds: string[] = [];
  const criticalTelegramTexts: string[] = [];

  for (const t of taskRows) {
    const f = fileById.get(t.file_id);
    if (!f) continue;
    const section: FileSection = isFileSection(f.section)
      ? f.section
      : 'potential';

    const color = fileColor(
      { section },
      [
        {
          status: t.status,
          accumulatedWorkingSeconds: toSeconds(t.accumulated_working_seconds),
          lastResumedAt: t.last_resumed_at,
          assignedAt: t.assigned_at,
        },
      ],
      settings,
      now
    );
    const level = color.alertLevel; // 'none' | 'warn' | 'critical'
    const last = t.last_alert_level; // null | 'warn' | 'critical'

    const label = fileLabel(f.client, f.opponent);
    const labelAr = fileLabelAr(f.client, f.opponent);

    // Upward transition into CRITICAL (from null or 'warn').
    if (level === 'critical' && last !== 'critical') {
      criticalTaskIds.push(t.id);
      criticalTelegramTexts.push(
        `🔴 ${companyName ? companyName + ': ' : ''}Task "${t.title}" on file "${label}" is critically overdue (red).`
      );
      // Notify ALL managers of the company (resolved once, below).
      // (queued via criticalTaskIds → managers loop after we know they exist)
      notifications.push({
        // placeholder replaced by manager fan-out below; we mark taskId/type
        // and expand per manager. Use a sentinel userId '' filtered out later.
        userId: '',
        companyId,
        taskId: t.id,
        type: 'overdue_critical',
        level: 'critical',
        messageEn: `Task "${t.title}" on file "${label}" is critically overdue (red).`,
        messageAr: `المهمة "${t.title}" في الملف "${labelAr}" متأخرة جداً (أحمر).`,
      });
      continue;
    }

    // Upward transition into WARN (only from null — never downgrade critical).
    if (level === 'warn' && last === null) {
      warnTaskIds.push(t.id);
      const msgEn = `Task "${t.title}" on file "${label}" is overdue (orange).`;
      const msgAr = `المهمة "${t.title}" في الملف "${labelAr}" متأخرة (برتقالي).`;
      // Responsible employee (assignee) + the task's approver.
      notifications.push({
        userId: t.assignee_id,
        companyId,
        taskId: t.id,
        type: 'overdue_warn',
        level: 'warn',
        messageEn: msgEn,
        messageAr: msgAr,
      });
      if (t.approver_id && t.approver_id !== t.assignee_id) {
        notifications.push({
          userId: t.approver_id,
          companyId,
          taskId: t.id,
          type: 'overdue_warn',
          level: 'warn',
          messageEn: msgEn,
          messageAr: msgAr,
        });
      }
    }
  }

  // 4) Expand critical notifications to every manager of the company, PLUS
  //    any employee explicitly granted 'notifications.overdue' ("the
  //    red/critical alerts managers receive" — capabilities.ts's own
  //    description of this exact expansion). The per-task critical rows were
  //    pushed with a sentinel userId ''; replace them with one row per
  //    recipient.
  const criticalRows = notifications.filter(
    (n) => n.type === 'overdue_critical'
  );
  const nonCriticalRows = notifications.filter(
    (n) => n.type !== 'overdue_critical'
  );
  const finalNotifications: NewNotification[] = nonCriticalRows;
  if (criticalRows.length > 0) {
    let recipientIds: string[] = [];
    try {
      const [managers, granted] = await Promise.all([
        listCompanyManagers(companyId),
        companyMembersWithCapability(companyId, 'notifications.overdue'),
      ]);
      recipientIds = Array.from(
        new Set([...managers.map((m) => m.userId), ...granted])
      );
    } catch {
      recipientIds = [];
    }
    for (const row of criticalRows) {
      for (const uid of recipientIds) {
        finalNotifications.push({ ...row, userId: uid });
      }
    }
  }

  // 5) Persist: write notifications (best-effort), stamp last_alert_level so we
  //    don't re-fire, then push Telegram for the critical transitions.
  await insertNotifications(finalNotifications);

  try {
    if (warnTaskIds.length > 0) {
      await supabase
        .from('tasks')
        .update({ last_alert_level: 'warn' })
        .in('id', warnTaskIds);
    }
    if (criticalTaskIds.length > 0) {
      await supabase
        .from('tasks')
        .update({ last_alert_level: 'critical' })
        .in('id', criticalTaskIds);
    }
  } catch (err) {
    console.error('evaluateAlerts: stamping last_alert_level failed:', err);
  }

  // Telegram is OPTIONAL and best-effort; sendTelegram re-checks the toggle +
  // token + chat id itself and never throws.
  if (comp.telegram_enabled === true && criticalTelegramTexts.length > 0) {
    for (const text of criticalTelegramTexts) {
      await sendTelegram(companyId, text);
    }
  }
}

// ---------------------------------------------------------------------------
// Task-transition notifications (spec §9): CREATED → approver, DONE →
// approver, SENT BACK → assignee. All GATED by the company's alerts_enabled
// and best-effort.
// ---------------------------------------------------------------------------

interface TaskCtxRow {
  id: string;
  title: string;
  assignee_id: string;
  approver_id: string;
  created_by: string;
  file_id: string;
}
interface FileCtxRow {
  company_id: string;
  client: string;
  opponent: string;
}

/**
 * Load the (task, file, company) context needed to address a transition
 * notification, returning null if anything is missing OR the company has alerts
 * disabled (so the caller simply does nothing). Never throws.
 */
async function loadAlertContext(taskId: string): Promise<{
  task: TaskCtxRow;
  file: FileCtxRow;
  companyId: string;
  label: string;
  labelAr: string;
} | null> {
  try {
    const supabase = getSupabaseAdmin();
    const tRes = await supabase
      .from('tasks')
      .select('id, title, assignee_id, approver_id, created_by, file_id')
      .eq('id', taskId)
      .maybeSingle();
    if (tRes.error) return null;
    const task = tRes.data as TaskCtxRow | null;
    if (!task) return null;

    const fRes = await supabase
      .from('files')
      .select('company_id, client, opponent')
      .eq('id', task.file_id)
      .maybeSingle();
    if (fRes.error) return null;
    const file = fRes.data as FileCtxRow | null;
    if (!file) return null;

    const cRes = await supabase
      .from('companies')
      .select('alerts_enabled')
      .eq('id', file.company_id)
      .maybeSingle();
    if (cRes.error) return null; // includes 42703 (migration not applied)
    const comp = cRes.data as { alerts_enabled: boolean | null } | null;
    if (!comp || comp.alerts_enabled === false) return null; // alerts OFF

    return {
      task,
      file,
      companyId: file.company_id,
      label: fileLabel(file.client, file.opponent),
      labelAr: fileLabelAr(file.client, file.opponent),
    };
  } catch (err) {
    console.error('loadAlertContext failed:', err);
    return null;
  }
}

/**
 * Task CREATED → notify the named approver ('task_created'). In-app only (no
 * Telegram, matching task_done/task_sent_back) — lets the approver know a new
 * task now needs their eventual sign-off without waiting for it to either go
 * overdue or be marked done. Best-effort.
 */
export async function notifyTaskCreated(taskId: string): Promise<void> {
  const ctx = await loadAlertContext(taskId);
  if (!ctx) return;
  const { task, companyId, label, labelAr } = ctx;
  await insertNotifications([
    {
      userId: task.approver_id,
      companyId,
      taskId: task.id,
      type: 'task_created',
      level: null,
      messageEn: `New task "${task.title}" on file "${label}" was assigned — you're the approver.`,
      messageAr: `مهمة جديدة "${task.title}" في الملف "${labelAr}" — أنت المعتمِد لها.`,
    },
  ]);
}

/** Task marked DONE → notify the named approver ('task_done'). Best-effort. */
export async function notifyTaskDone(taskId: string): Promise<void> {
  const ctx = await loadAlertContext(taskId);
  if (!ctx) return;
  const { task, companyId, label, labelAr } = ctx;
  await insertNotifications([
    {
      userId: task.approver_id,
      companyId,
      taskId: task.id,
      type: 'task_done',
      level: null,
      messageEn: `Task "${task.title}" on file "${label}" was marked done and awaits your approval.`,
      messageAr: `تم وضع علامة "منجزة" على المهمة "${task.title}" في الملف "${labelAr}" وتنتظر موافقتك.`,
    },
  ]);
}

/** Task SENT BACK → notify the responsible employee ('task_sent_back'). */
export async function notifyTaskSentBack(taskId: string): Promise<void> {
  const ctx = await loadAlertContext(taskId);
  if (!ctx) return;
  const { task, companyId, label, labelAr } = ctx;
  await insertNotifications([
    {
      userId: task.assignee_id,
      companyId,
      taskId: task.id,
      type: 'task_sent_back',
      level: null,
      messageEn: `Task "${task.title}" on file "${label}" was sent back to you for changes.`,
      messageAr: `أُعيدت إليك المهمة "${task.title}" في الملف "${labelAr}" لإجراء تعديلات.`,
    },
  ]);
}

/**
 * Someone was booked on leave while holding open tasks → tell each APPROVER who
 * has work sitting with them, since the approver is who can reassign it.
 *
 * Leave deliberately does NOT pause the task clock (the folder keeps ageing
 * toward red), so this notice is the whole mechanism by which the work gets
 * picked up while they are away. Best-effort, like every other notifier here.
 *
 * ONE NOTIFICATION PER APPROVER, NOT PER TASK. Testing found a single booking
 * for someone holding 47 open tasks producing 47 bell items, which buries the
 * approver rather than informing them. The per-task detail is not lost: the
 * folder's Details tab already names every affected task in red.
 */
export async function notifyAssigneeOnLeave(period: {
  userId: string;
  companyId: string;
  endDate: string;
}): Promise<void> {
  const tasks = await listTasksForAssignee(period.userId);

  // OPEN only: a task already awaiting approval needs no reassignment, and one
  // that is approved is finished. Company-scoped because listTasksForAssignee
  // spans every company this person belongs to.
  const relevant = tasks.filter(
    (t) => t.status === 'open' && t.file.companyId === period.companyId
  );
  if (relevant.length === 0) return;

  const countByApprover = new Map<string, number>();
  for (const t of relevant) {
    const approverId = t.approver?.userId;
    if (!approverId) continue;
    countByApprover.set(approverId, (countByApprover.get(approverId) ?? 0) + 1);
  }
  if (countByApprover.size === 0) return;

  // The person going away, named from the tasks themselves (every one of these
  // is assigned to them, so any row carries the name).
  const who = relevant[0].assignee;
  const nameEn = who?.fullNameEn || who?.fullNameAr || who?.username || '';
  const nameAr = who?.fullNameAr || who?.fullNameEn || who?.username || '';

  await insertNotifications(
    [...countByApprover].map(([approverId, count]) => ({
      userId: approverId,
      companyId: period.companyId,
      // Not about one task, so no task id — this is a summary.
      taskId: null,
      type: 'assignee_on_leave' as const,
      level: null,
      messageEn: `${nameEn} is on leave until ${period.endDate} — ${count} of your open ${
        count === 1 ? 'task needs' : 'tasks need'
      } reassigning.`,
      messageAr: `${nameAr} في إجازة حتى ${period.endDate} — ${count} من مهامك المفتوحة تحتاج إعادة إسناد.`,
    }))
  );
}
