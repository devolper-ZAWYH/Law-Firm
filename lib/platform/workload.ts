import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { scheduledMinutes } from './lateness';
import { scheduleBlocksOnDate } from './scheduleBlocks';

/**
 * WORKLOAD CAPACITY — how many hours of work a person can absorb on one day,
 * which is the denominator every load bar on the Employee Tasks calendar is
 * drawn against ("2 / 4h").
 *
 * WHERE THE NUMBER COMES FROM, AND WHY IT IS NOT A NEW SETTING
 *   Every membership can already carry a schedule — work_start_time,
 *   work_end_time and working_days (migration #17, lib/platform/workingHours.ts)
 *   — set on the employee's own edit card. Someone who works 09:00–13:00 has a
 *   four-hour day, and that is exactly the capacity a load bar needs.
 *
 *   Adding a separate "capacity" field instead would create two numbers that
 *   mean the same thing and are free to disagree: an employee whose hours were
 *   changed from four to six would keep a stale capacity of four until someone
 *   remembered a second screen existed, and the bar would confidently show them
 *   overloaded every afternoon. Deriving it means the schedule stays the single
 *   place a person's day is described.
 *
 * WHAT AN UNSET SCHEDULE MEANS
 *   Most memberships have no schedule: the columns are nullable and were
 *   informational until now. Those people get DEFAULT_CAPACITY_HOURS rather
 *   than a zero — a zero-capacity bar reads as "this person is infinitely
 *   overloaded" the moment they are given anything at all, which is a lie about
 *   a missing setting, not a fact about their week.
 *
 *   `configured` is reported alongside the number so the UI can say which it
 *   is. A bar drawn against a guess should not look identical to one drawn
 *   against what the firm actually agreed with that person.
 *
 * NON-WORKING DAYS
 *   `workingDays` is echoed unchanged (0=Sunday..6=Saturday, or null when never
 *   set). A day outside it has no capacity at all — work planned onto someone's
 *   day off is over capacity by definition, however little of it there is — and
 *   the calendar renders those days differently rather than pretending the
 *   normal allowance applies.
 */

/**
 * The capacity assumed for a person whose schedule nobody has filled in.
 *
 * Eight, the conventional full day. It is deliberately GENEROUS: the cost of
 * guessing high is a bar that under-reports pressure, which is a quiet wrong
 * answer; the cost of guessing low is every unconfigured employee showing as
 * overloaded, which is a loud wrong answer that would train people to ignore
 * the colour entirely.
 */
export const DEFAULT_CAPACITY_HOURS = 8;

export interface DailyCapacity {
  /** Hours of work this person absorbs on a normal working day. */
  hours: number;
  /** Weekday numbers they work (0=Sunday..6=Saturday), or null if never set. */
  workingDays: number[] | null;
  /** False when `hours` is DEFAULT_CAPACITY_HOURS because nothing was set. */
  configured: boolean;
  /**
   * Hours per weekday, indexed 0=Sunday..6=Saturday — set only for somebody
   * with a block schedule (#42), whose days genuinely differ from each other.
   * The calendar prefers it and falls back to the flat `hours`, so a membership
   * described by a single start/end pair behaves exactly as before.
   */
  hoursByWeekday?: number[];
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight, or null if unparseable. */
function toMinutes(time: string | null): number | null {
  if (!time) return null;
  const parts = time.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * The length of a working day, in hours, from its start and end times.
 *
 * An END BEFORE THE START is read as a shift crossing midnight (22:00 → 02:00
 * is four hours, not minus twenty). Night shifts are real, and the alternative
 * — treating it as invalid — would silently hand those people the default
 * instead of the hours they actually work.
 *
 * Returns null when either time is missing or the pair yields nothing usable,
 * which the caller turns into the documented default.
 */
export function capacityFromTimes(
  startTime: string | null,
  endTime: string | null
): number | null {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null) return null;
  const span = end > start ? end - start : end + 24 * 60 - start;
  if (span <= 0) return null;
  // Two decimals: a 09:00–13:30 day is 4.5 hours, and nothing finer than a
  // quarter of an hour is ever configured.
  return Math.round((span / 60) * 100) / 100;
}

interface MembershipScheduleRow {
  user_id: string;
  working_days: number[] | null;
  work_start_time: string | null;
  work_end_time: string | null;
}

/**
 * Daily capacity for many people in ONE company, in a single query.
 *
 * Everyone asked for comes back — a user with no membership row, or one with an
 * empty schedule, gets the default rather than being missing from the map, so
 * the caller never has to decide what an absent key means.
 *
 * DEPLOY SAFETY: migration #17's columns may not exist yet (42703). That is not
 * an error worth failing a calendar over — every person simply falls back to
 * the default, which is precisely the behaviour before schedules existed.
 */
export async function getDailyCapacities(
  companyId: string,
  userIds: string[]
): Promise<Map<string, DailyCapacity>> {
  const out = new Map<string, DailyCapacity>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return out;

  const fallback: DailyCapacity = {
    hours: DEFAULT_CAPACITY_HOURS,
    workingDays: null,
    configured: false,
  };
  for (const id of unique) out.set(id, { ...fallback });

  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('memberships')
    .select('user_id, working_days, work_start_time, work_end_time')
    .eq('company_id', companyId)
    .in('user_id', unique);
  if (res.error) {
    if ((res.error as { code?: string }).code === '42703') return out;
    throw new Error(res.error.message);
  }

  for (const row of (res.data as MembershipScheduleRow[] | null) ?? []) {
    const hours = capacityFromTimes(row.work_start_time, row.work_end_time);
    out.set(row.user_id, {
      hours: hours ?? DEFAULT_CAPACITY_HOURS,
      workingDays: row.working_days ?? null,
      configured: hours !== null,
    });
  }

  /*
    A BLOCK SCHEDULE GIVES EACH WEEKDAY ITS OWN CAPACITY (#42).

    The single start/end pair can only say "every working day is six hours". A
    real schedule is Monday six and Thursday three, so one number drew Thursday
    as half-empty when it was full. Where somebody has blocks, their capacity
    becomes the hours their week actually contains, day by day.

    Resolved as of TODAY: the calendar plans forward, and a term that has not
    started yet is not the one work is being planned against.
  */
  const today = new Date().toISOString().slice(0, 10);
  const blocksByUser = await scheduleBlocksOnDate(companyId, unique, today);
  for (const [userId, blocks] of blocksByUser) {
    if (blocks.length === 0) continue;
    const hoursByWeekday = [0, 1, 2, 3, 4, 5, 6].map(
      (d) => scheduledMinutes(blocks, d) / 60
    );
    const scheduledDays = hoursByWeekday
      .map((h, d) => (h > 0 ? d : -1))
      .filter((d) => d >= 0);
    const existing = out.get(userId);
    out.set(userId, {
      hours: existing?.hours ?? DEFAULT_CAPACITY_HOURS,
      // The days the blocks actually cover — the older working_days list can
      // disagree, and the blocks are the more specific statement.
      workingDays: scheduledDays,
      configured: true,
      hoursByWeekday,
    });
  }
  return out;
}

/**
 * People to LEAVE OUT of the Employee Tasks workload calendar.
 *
 * Two reasons, and they are different kinds of thing:
 *
 *   • FROZEN accounts. A frozen person cannot sign in and is already treated
 *     as "no such user" everywhere authorization is decided (see the freeze
 *     check in getPlatformUser). Planning work for them is not a thing anyone
 *     means to do, so they leave the roster with their account, and nobody has
 *     to remember a second switch.
 *
 *   • HIDDEN, per membership (migration #41). A manager's own choice, made on
 *     the employee's card, for someone they are simply not planning work for.
 *     It hides a ROW; it grants and revokes nothing.
 *
 * Returns the ids to drop. Deliberately a subtraction rather than a filtered
 * roster: the roster is assembled from two membership queries and de-duplicated
 * by the caller, and doing the exclusion there keeps that assembly in one place.
 *
 * DEPLOY SAFETY: `hidden_from_workload` arrives in #41 and new code reaches
 * production before its migration runs. A missing column degrades to "nobody is
 * hidden" — the behaviour before the flag existed — rather than failing the
 * whole overview. Frozen accounts are still excluded in that case, because that
 * half reads a column that has existed since #24.
 */
export async function workloadExcludedUserIds(
  companyId: string,
  userIds: string[]
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (userIds.length === 0) return excluded;
  const supabase = getSupabaseAdmin();

  const frozen = await supabase
    .from('app_users')
    .select('id')
    .in('id', userIds)
    .eq('is_frozen', true);
  if (frozen.error) throw new Error(frozen.error.message);
  for (const r of (frozen.data as { id: string }[] | null) ?? []) excluded.add(r.id);

  const hidden = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .in('user_id', userIds)
    .eq('hidden_from_workload', true);
  if (hidden.error) {
    // 42703 = undefined_column. Anything else is a real failure.
    const code = (hidden.error as { code?: string }).code;
    if (code !== '42703' && code !== '42P01') {
      throw new Error(hidden.error.message);
    }
  } else {
    for (const r of (hidden.data as { user_id: string }[] | null) ?? []) {
      excluded.add(r.user_id);
    }
  }

  return excluded;
}
