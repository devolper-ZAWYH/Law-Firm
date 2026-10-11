/**
 * Lateness rule — how many minutes late an employee was on a given day.
 *
 * Deliberately PURE (no `server-only`, no database, no clock) so the rule can be
 * unit-tested directly and so the SAME function can be applied both when an
 * attendance sheet is stored and when a summary is read. Those two paths used to
 * disagree: the stored value came from the sheet's own "Late In(M)" column while
 * the summaries separately filtered out non-working days.
 *
 * THE RULE, in order:
 *
 *   1. Not one of the employee's working days  → 0. They were not expected in,
 *      so no arrival can be late. An employee with no configured working days
 *      (null) is treated as working every day — matching how the summaries
 *      already behaved, so configuring nothing changes nothing.
 *
 *   2. Their start time is configured and we know when they clocked in
 *      → max(0, clock_in − start_time). Arriving early is 0, never negative.
 *
 *   3. Otherwise → fall back to the sheet's own Late In(M) value. This is what
 *      happens for an employee whose schedule has never been set, or on a row
 *      where the device recorded no clock-in, so uploading a sheet for an
 *      unconfigured team behaves exactly as it did before this rule existed.
 *
 * The employee's schedule lives on their MEMBERSHIP (memberships.working_days /
 * work_start_time, migration #17), so it is per-company: the same person can
 * keep different hours at two companies.
 */

/** 0 = Sunday … 6 = Saturday, matching `memberships.working_days`. */
export function isoDateWeekday(date: string): number {
  // Midday avoids any timezone rounding landing on the neighbouring day.
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * Minutes since midnight for 'HH:MM' or 'HH:MM:SS'. Postgres `time` columns
 * round-trip with seconds; the UI stores 'HH:MM'. Returns null if unparseable,
 * which callers treat as "not configured" rather than as zero.
 */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** An employee's schedule in one company. Either field may be unset. */
export interface WorkSchedule {
  /** Weekday numbers they are expected in, or null when never configured. */
  workingDays: number[] | null;
  /** 'HH:MM' start time, or null when never configured. */
  startTime: string | null;
  /**
   * The week as INTERVALS, when this membership has one (migration #42).
   *
   * Only the blocks in force on the date being judged, already filtered by the
   * caller — this file stays pure, so it does no date-range work it cannot be
   * unit-tested on. Empty or absent means "no block schedule", and the single
   * start time above remains the rule, exactly as before.
   */
  blocks?: ScheduleBlock[];
}

/** One interval of one weekday, in one mode. See migration #42. */
export interface ScheduleBlock {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** 'HH:MM' or 'HH:MM:SS'. */
  startTime: string;
  endTime: string;
  mode: 'office' | 'online';
}

/**
 * When this person is first expected IN THE OFFICE on `date`, in minutes since
 * midnight — or null if they are not expected in at all that day.
 *
 * This is the number the whole feature turns on. The device can only see
 * somebody physically present, so lateness must be measured from the first
 * OFFICE block of the day and not from when their working day happens to
 * begin. On a day that starts with three hours online and reaches the office at
 * 14:30, measuring from 09:00 reports five and a half hours of lateness for
 * somebody who did nothing wrong.
 *
 * A day with online blocks but no office block returns null: there is nothing
 * for the device to have seen, so there is no arrival to be late for.
 */
export function firstOfficeStartMinutes(
  blocks: ScheduleBlock[],
  weekday: number
): number | null {
  let earliest: number | null = null;
  for (const b of blocks) {
    if (b.weekday !== weekday || b.mode !== 'office') continue;
    const start = timeToMinutes(b.startTime);
    if (start === null) continue;
    if (earliest === null || start < earliest) earliest = start;
  }
  return earliest;
}

/** Does this day have any block at all — office or online? */
export function hasAnyBlock(blocks: ScheduleBlock[], weekday: number): boolean {
  return blocks.some((b) => b.weekday === weekday);
}

/** Scheduled minutes on a weekday, both modes — the day's capacity. */
export function scheduledMinutes(
  blocks: ScheduleBlock[],
  weekday: number,
  mode?: 'office' | 'online'
): number {
  let total = 0;
  for (const b of blocks) {
    if (b.weekday !== weekday) continue;
    if (mode && b.mode !== mode) continue;
    const start = timeToMinutes(b.startTime);
    const end = timeToMinutes(b.endTime);
    if (start === null || end === null || end <= start) continue;
    total += end - start;
  }
  return total;
}

/**
 * How a day is classified (migration #25). 'present' is the ordinary case and
 * the default for every row uploaded before this existed.
 */
export type DayStatus = 'present' | 'absent' | 'vacation';

/**
 * An absent day counts as a full working day late — 8 hours.
 *
 * Kept as a named constant, and applied at READ time rather than baked into
 * the stored minutes, so changing the firm's working day later re-scores
 * history instead of leaving old rows on the old figure.
 */
export const ABSENT_LATE_MINUTES = 8 * 60;

export function isDayStatus(value: unknown): value is DayStatus {
  return value === 'present' || value === 'absent' || value === 'vacation';
}

export interface LatenessInput {
  /** 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:MM[:SS]' as recorded by the device, or null if it recorded none. */
  clockIn: string | null;
  /** The sheet's own Late In(M), used only when the rule cannot be applied. */
  sheetLateMinutes: number;
  schedule: WorkSchedule;
  /** Defaults to 'present' when not supplied. */
  dayStatus?: DayStatus | null;
}

export function computeLateMinutes(input: LatenessInput): number {
  const { date, clockIn, sheetLateMinutes, schedule } = input;
  const dayStatus: DayStatus = isDayStatus(input.dayStatus)
    ? input.dayStatus
    : 'present';

  // 0. An explicitly marked day is decided by its mark, whatever the device
  //    recorded. Vacation is approved leave, so it is not lateness at all;
  //    absent is a whole working day missed. Checked before the working-day
  //    test so marking someone absent is never silently discarded.
  if (dayStatus === 'vacation') return 0;
  if (dayStatus === 'absent') return ABSENT_LATE_MINUTES;

  const weekday = isoDateWeekday(date);
  const blocks = schedule.blocks ?? [];
  const arrivalMinutes = timeToMinutes(clockIn);

  // 1a. A BLOCK SCHEDULE ANSWERS ON ITS OWN, and outranks the single start
  //     time — a membership that has blocks is described by them.
  if (blocks.length > 0) {
    // Nothing scheduled at all: not a working day for this person.
    if (!hasAnyBlock(blocks, weekday)) return 0;

    const officeStart = firstOfficeStartMinutes(blocks, weekday);

    // Scheduled, but never in the office — a fully-online day. The device
    // cannot see online work, so there is no arrival to be late for and its
    // silence means nothing. The firm's rule is that online hours are worked
    // unless a manager says otherwise, and that mark arrives as dayStatus,
    // which was already handled above.
    if (officeStart === null) return 0;

    // In the office at some point: measured from the first OFFICE block, not
    // from when the working day began. This is the whole point — a day that
    // opens with three hours online and reaches the office at 14:30 is judged
    // against 14:30.
    if (arrivalMinutes !== null) return Math.max(0, arrivalMinutes - officeStart);

    // Expected in, no record of arriving. Fall through to the sheet's own
    // figure rather than inventing one.
    return Number.isFinite(sheetLateMinutes) && sheetLateMinutes > 0
      ? Math.round(sheetLateMinutes)
      : 0;
  }

  // 1b. No blocks — the pre-#42 rule, unchanged.
  const workingDays = schedule.workingDays;
  if (workingDays && workingDays.length > 0) {
    if (!workingDays.includes(weekday)) return 0;
  }

  // 2. Both sides of the comparison are known → measure it.
  const startMinutes = timeToMinutes(schedule.startTime);
  if (startMinutes !== null && arrivalMinutes !== null) {
    return Math.max(0, arrivalMinutes - startMinutes);
  }

  // 3. Nothing to measure against — keep whatever the device reported.
  return Number.isFinite(sheetLateMinutes) && sheetLateMinutes > 0
    ? Math.round(sheetLateMinutes)
    : 0;
}
