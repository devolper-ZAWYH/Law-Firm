import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import type { WorkSchedule } from './lateness';

/**
 * Per-employee, per-company WORKING HOURS (memberships.working_days /
 * work_start_time / work_end_time — migration #17).
 *
 * These drive the ATTENDANCE LATENESS RULE: how late someone was is measured
 * against the start time configured here, and only on their configured working
 * days (see lib/platform/lateness.ts, applied in lib/platform/attendance.ts).
 * A membership with no schedule set behaves exactly as before — every day
 * counts and the sheet's own Late In(M) is used verbatim.
 *
 * Unrelated to the company-wide color-engine working_days
 * (lib/platform/colorEngine.ts), which governs task timers, not attendance.
 */

export interface WorkingHours {
  /** Weekday numbers (0=Sunday..6=Saturday), or null if never set. */
  workingDays: number[] | null;
  /** 'HH:MM' (24h), or null if never set. */
  startTime: string | null;
  /** 'HH:MM' (24h), or null if never set. */
  endTime: string | null;
}

interface MembershipRow {
  working_days: number[] | null;
  work_start_time: string | null;
  work_end_time: string | null;
}

function trimSeconds(t: string | null): string | null {
  // Postgres `time` round-trips as 'HH:MM:SS'; the UI only needs 'HH:MM'.
  return t ? t.slice(0, 5) : null;
}

export async function getWorkingHours(
  userId: string,
  companyId: string
): Promise<WorkingHours> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('memberships')
    .select('working_days, work_start_time, work_end_time')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as MembershipRow | null;
  return {
    workingDays: row?.working_days ?? null,
    startTime: trimSeconds(row?.work_start_time ?? null),
    endTime: trimSeconds(row?.work_end_time ?? null),
  };
}

/**
 * Bulk SCHEDULE lookup for many users in ONE company — the working days AND the
 * start time, which together define the lateness rule (lib/platform/lateness.ts).
 *
 * Fetched in one query rather than per-employee because both the upload path and
 * the summary path need every uploaded employee's schedule at once.
 *
 * A user with no membership row, or with nothing configured, comes back as
 * `{ workingDays: null, startTime: null }` — which the rule treats as "works
 * every day, no measurable start time", i.e. exactly the behaviour that existed
 * before schedules were used for anything.
 */
export async function getWorkingSchedulesForUsers(
  companyId: string,
  userIds: string[]
): Promise<Map<string, WorkSchedule>> {
  const out = new Map<string, WorkSchedule>();
  const uniqueIds = Array.from(new Set(userIds));
  if (uniqueIds.length === 0) return out;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('memberships')
    .select('user_id, working_days, work_start_time')
    .eq('company_id', companyId)
    .in('user_id', uniqueIds);
  if (res.error) throw new Error(res.error.message);
  for (const row of (res.data as
    | { user_id: string; working_days: number[] | null; work_start_time: string | null }[]
    | null) ?? []) {
    out.set(row.user_id, {
      workingDays: row.working_days ?? null,
      startTime: trimSeconds(row.work_start_time ?? null),
    });
  }
  return out;
}

/** Set (admin/manager only, enforced by the caller) one membership's schedule. */
export async function setWorkingHours(
  userId: string,
  companyId: string,
  patch: Partial<WorkingHours>
): Promise<WorkingHours> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, unknown> = {};
  if (patch.workingDays !== undefined) update.working_days = patch.workingDays;
  if (patch.startTime !== undefined) update.work_start_time = patch.startTime;
  if (patch.endTime !== undefined) update.work_end_time = patch.endTime;

  const res = await supabase
    .from('memberships')
    .update(update)
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .select('working_days, work_start_time, work_end_time')
    .single();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as MembershipRow;
  return {
    workingDays: row.working_days ?? null,
    startTime: trimSeconds(row.work_start_time),
    endTime: trimSeconds(row.work_end_time),
  };
}
