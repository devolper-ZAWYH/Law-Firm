// Working-time arithmetic for the task timer.
//
// CLIENT-SAFE (no `server-only`): a pure function with no I/O, so it can be
// reused anywhere (server timer freeze, or later the color engine / UI).
//
// A task's "working time" only counts seconds that fall on the company's
// WORKING DAYS (weekday integers, 0=Sunday … 6=Saturday — the same encoding as
// companies.working_days, Sun–Thu by default). Weekend seconds do not count.
//
// Day boundaries are evaluated in UTC. Both timestamps we compare are stored as
// timestamptz (UTC) in Postgres, so UTC boundaries keep the arithmetic
// deterministic on the server (Railway runs in UTC). This is intentionally
// simple: sub-day precision by wall-clock timezone is not needed for the
// timer/color model, only that weekend days are excluded.

/**
 * The number of WORKING seconds between two instants, counting only seconds
 * whose UTC calendar day is one of `workingDays`. Returns 0 if `to <= from`,
 * if either date is invalid, or if `workingDays` is empty.
 */
export function workingSecondsBetween(
  from: Date,
  to: Date,
  workingDays: number[]
): number {
  const start = from.getTime();
  const end = to.getTime();
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    !(end > start) ||
    !Array.isArray(workingDays) ||
    workingDays.length === 0
  ) {
    return 0;
  }

  const workingSet = new Set(workingDays);
  let total = 0; // milliseconds
  let cursor = start;

  // Walk one UTC calendar day at a time. `dayEnd` (next UTC midnight) is always
  // strictly greater than `cursor`, so the loop always advances and terminates.
  while (cursor < end) {
    const d = new Date(cursor);
    const weekday = d.getUTCDay();
    const dayEnd = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1,
      0,
      0,
      0,
      0
    );
    const segmentEnd = Math.min(dayEnd, end);
    if (workingSet.has(weekday)) {
      total += segmentEnd - cursor;
    }
    cursor = segmentEnd;
  }

  return Math.floor(total / 1000);
}
