import 'server-only';
import { getSupabaseAdmin } from '../supabase';

/**
 * Notifications data-access layer (Phase 7).
 *
 * Pure data access over the `notifications` table using the service-role client.
 * AUTHORIZATION (who may read/mark) is enforced by the API routes: a caller only
 * ever touches rows where user_id == their own id.
 *
 * DEPLOY SAFETY: every read/write degrades gracefully (empty / no-op) if the
 * Phase-7 migration has not been applied yet (Postgres 42P01 — relation missing
 * / 42703 — column missing), so the notifications bell never 500s the shell.
 */

export type NotificationType =
  | 'overdue_warn'
  | 'overdue_critical'
  | 'task_created'
  | 'task_done'
  | 'task_sent_back'
  | 'mention'
  | 'attendance_objection'
  | 'assignee_on_leave'
  // Capability approvals (lib/platform/approvals.ts). 'approval_requested'
  // goes to the company's approving manager; the other two go back to the
  // employee who asked.
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_rejected';

export interface NotificationRow {
  id: string;
  companyId: string;
  taskId: string | null;
  type: string;
  level: string | null;
  messageEn: string | null;
  messageAr: string | null;
  isRead: boolean;
  createdAt: string;
}

interface RawNotificationRow {
  id: string;
  company_id: string;
  task_id: string | null;
  type: string;
  level: string | null;
  message_en: string | null;
  message_ar: string | null;
  is_read: boolean;
  created_at: string;
}

/** One notification to insert (addressed to a single user). */
export interface NewNotification {
  userId: string;
  companyId: string;
  taskId: string | null;
  type: NotificationType;
  level: 'warn' | 'critical' | null;
  messageEn: string;
  messageAr: string;
}

function isMissingTable(err: { code?: string } | null): boolean {
  const code = err?.code;
  return code === '42P01' || code === '42703';
}

/**
 * Insert a batch of notifications (best-effort). De-duplicates identical
 * (user, task, type) targets within the batch so the same person isn't notified
 * twice for one event. Never throws — a failed insert must not break the caller
 * (alert evaluation / task transitions are wrapped, but we defend here too).
 */
export async function insertNotifications(
  items: NewNotification[]
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;

  // Collapse duplicates targeting the same user/task/type in one batch.
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const it of items) {
    if (!it || !it.userId) continue;
    const key = `${it.userId}|${it.taskId ?? ''}|${it.type}|${it.level ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      user_id: it.userId,
      company_id: it.companyId,
      task_id: it.taskId,
      type: it.type,
      level: it.level,
      message_en: it.messageEn,
      message_ar: it.messageAr,
    });
  }
  if (rows.length === 0) return;

  try {
    const supabase = getSupabaseAdmin();
    const res = await supabase.from('notifications').insert(rows);
    if (res.error && !isMissingTable(res.error as { code?: string })) {
      console.error('Insert notifications error:', res.error.message);
    }
  } catch (err) {
    console.error('Insert notifications threw:', err);
  }
}

/** A user's notifications, newest-first (capped), plus their unread count. */
export async function listNotificationsForUser(
  userId: string,
  limit = 50
): Promise<{ notifications: NotificationRow[]; unreadCount: number }> {
  const empty = { notifications: [] as NotificationRow[], unreadCount: 0 };
  if (!userId) return empty;
  const supabase = getSupabaseAdmin();

  const listRes = await supabase
    .from('notifications')
    .select(
      'id, company_id, task_id, type, level, message_en, message_ar, is_read, created_at'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (listRes.error) {
    if (isMissingTable(listRes.error as { code?: string })) return empty;
    throw new Error(listRes.error.message);
  }
  const rows = (listRes.data as RawNotificationRow[] | null) ?? [];

  const countRes = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (countRes.error) {
    if (isMissingTable(countRes.error as { code?: string })) {
      return { notifications: rows.map(mapRow), unreadCount: 0 };
    }
    throw new Error(countRes.error.message);
  }

  return {
    notifications: rows.map(mapRow),
    unreadCount: countRes.count ?? 0,
  };
}

function mapRow(r: RawNotificationRow): NotificationRow {
  return {
    id: r.id,
    companyId: r.company_id,
    taskId: r.task_id,
    type: r.type,
    level: r.level,
    messageEn: r.message_en,
    messageAr: r.message_ar,
    isRead: r.is_read,
    createdAt: r.created_at,
  };
}

/**
 * Mark the caller's notifications read. With an id → just that one (scoped to the
 * user so a caller can only mark their own). Without → all of the user's unread.
 */
export async function markNotificationsRead(
  userId: string,
  id?: string
): Promise<void> {
  if (!userId) return;
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId);
  if (id) q = q.eq('id', id);
  else q = q.eq('is_read', false);
  const res = await q;
  if (res.error && !isMissingTable(res.error as { code?: string })) {
    throw new Error(res.error.message);
  }
}
