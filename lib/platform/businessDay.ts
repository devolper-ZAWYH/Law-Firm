/**
 * THE FIRM'S CALENDAR DAY.
 *
 * CLIENT-SAFE (no `server-only`): the attendance banner needs the same "today"
 * the server used, or the two disagree about which day is being reported.
 *
 * WHY THIS EXISTS
 *   Qatar is UTC+3 with no DST, so between local midnight and 03:00 the UTC
 *   date is still YESTERDAY. Anything that asks "what day is it" via
 *   `new Date().toISOString().slice(0, 10)` is wrong for those three hours
 *   every single day — leave booked to start today would not block an
 *   assignment, the 25th→25th attendance period would flip a day late, and
 *   "strictly before today" would silently include today's own row.
 *
 *   Dates in this system are calendar days people NAME — "I'm away on the 9th",
 *   "the period runs to the 25th" — not instants. They have to be resolved
 *   against the day the firm is actually living in.
 *
 * WHAT THIS IS *NOT* FOR
 *   Pure date arithmetic on a 'YYYY-MM-DD' string (shifting by N days, taking a
 *   difference) is correctly done by anchoring at UTC midnight, because both
 *   ends are date-only and the offset cancels. Do not route that through here.
 *   This module answers "what is today", nothing else.
 */

/** Qatar, UTC+3, no DST. The single place the firm's zone is named. */
export const BUSINESS_TIME_ZONE = 'Asia/Qatar';

/** 'en-CA' formats as YYYY-MM-DD, which is exactly the shape dates are stored in. */
const ISO_IN_ZONE = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The firm's current calendar day as 'YYYY-MM-DD'. */
export function todayIso(now: Date = new Date()): string {
  return ISO_IN_ZONE.format(now);
}

/**
 * The firm's calendar day as its numeric parts — for callers that need to do
 * month/day arithmetic (the 25th→25th attendance period) rather than compare
 * strings.
 */
export function businessDateParts(now: Date = new Date()): {
  year: number;
  month: number; // 1-based, as written
  day: number;
} {
  const [year, month, day] = todayIso(now).split('-').map(Number);
  return { year, month, day };
}

/** `iso` shifted by whole days. Pure date maths — UTC anchoring is correct here. */
export function shiftIsoDate(iso: string, offsetDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
