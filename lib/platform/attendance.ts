import 'server-only';
import * as XLSX from 'xlsx';
import { getSupabaseAdmin } from '../supabase';
import { insertNotifications } from './notifications';
import { getWorkingSchedulesForUsers } from './workingHours';
import { scheduleBlockLookup } from './scheduleBlocks';
import { assertSafeSpreadsheetEnvelope } from './spreadsheetGuard';
import { businessDateParts, todayIso } from './businessDay';
import {
  computeLateMinutes,
  isoDateWeekday,
  type DayStatus,
  hasAnyBlock,
  type ScheduleBlock,
  type WorkSchedule,
} from './lateness';

/**
 * Attendance — parses a ZKTeco "Total Time Card" Excel export and stores one
 * row per (employee, calendar day) in `attendance_records` (migrations
 * #20-21), tracking Late In(M) and Early Out(M) as SEPARATE totals (both
 * read straight from the sheet's own columns — never recomputed). Clock Out
 * and Total Hours/OT are stored for reference but never aggregated.
 *
 * MATCHING: each sheet row's "Employee ID" is matched against
 * memberships.zkteco_employee_id (set once per person by an admin/manager —
 * see the employee edit card). A row whose ID has no match is skipped and
 * reported back, never guessed by name.
 *
 * DISPUTES: an employee can object to a specific day (e.g. "I had
 * permission") — see attendance_objections (migration #22) below.
 */

export interface AttendanceUploadResult {
  totalRows: number;
  matchedRows: number;
  unmatchedZktecoIds: string[];
  /** Earliest/latest date found in the sheet's own Date column, so the uploader
   * can confirm which day(s) this upload actually covers. Null if no rows. */
  dateRange: { start: string; end: string } | null;
  /** ZKTeco id → app_users.id, for the rows that matched a person. Objections
   * raised in the review table name an employee by their SHEET id; this is how
   * the upload route turns that into the user the objection is about. */
  userIdByZktecoId: Map<string, string>;
}

export interface SheetRow {
  employeeId: string;
  date: string; // 'YYYY-MM-DD'
  clockIn: string | null; // 'HH:MM'
  clockOut: string | null; // 'HH:MM'
  lateMinutes: number;
  earlyOutMinutes: number;
  /**
   * Set by the uploader on the confirm screen, not by the device: the sheet
   * cannot tell "did not come in" from "no record". Defaults to 'present'.
   */
  dayStatus?: DayStatus;
}

// Aliases are matched against a normalizeHeader()'d cell — lowercased with all
// non-alphanumeric characters stripped — so "Employee ID", "Emp. ID:", "EMP-ID"
// and "employeeid" all collapse to the same "employeeid" and match one alias.
const HEADER_ALIASES: Record<string, string[]> = {
  employeeId: [
    'employeeid',
    'empid',
    'empno',
    'employeeno',
    'staffid',
    'staffno',
    'personnelid',
    'personnelno',
    'userid',
    'badgeid',
    'badgeno',
    'id',
  ],
  date: ['date', 'attdate', 'attendancedate', 'workdate', 'checkdate'],
  clockIn: ['clockin', 'timein', 'checkin', 'intime', 'firstin'],
  clockOut: ['clockout', 'timeout', 'checkout', 'outtime', 'lastout'],
  // NOTE: deliberately no bare "late" alias — it's only 1 edit away from
  // "date" itself and would risk matching the Date column under fuzzy mode.
  lateMinutes: ['lateinm', 'latem', 'lateminutes', 'latein'],
  earlyOutMinutes: [
    'earlyoutm',
    'earlym',
    'earlyoutminutes',
    'earlyout',
    'earlyleavem',
    'earlyleave',
    'leaveearlym',
  ],
  // Optional — used only to sanity-check/self-correct the Date column (see
  // correctDateAgainstWeekday below), not required for a sheet to parse.
  weekday: ['weekday', 'dayofweek', 'wkday', 'day'],
};

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function parseWeekdayIndex(v: unknown): number | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s in WEEKDAY_INDEX ? WEEKDAY_INDEX[s] : null;
}

function shiftIsoDateBy(date: string, offsetDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Some export tools stamp the Date column with a timestamp right at a
 * midnight boundary (e.g. "20:59:52Z"), which — depending on the timezone the
 * exporting system actually meant — can land on the wrong CALENDAR day once
 * we take just the date part. The sheet's own "Weekday" column (when present)
 * names the intended day in plain text, so cross-check against it and nudge
 * the date by ±1 (the only plausible drift from a near-midnight rounding
 * issue) if they disagree — never further, since a bigger mismatch means the
 * weekday text itself is unreliable and guessing would be worse than leaving
 * the date alone.
 */
function correctDateAgainstWeekday(date: string, weekdayCell: unknown): string {
  const expected = parseWeekdayIndex(weekdayCell);
  if (expected === null) return date;
  const actual = isoDateWeekday(date);
  if (actual === expected) return date;
  if ((actual + 1) % 7 === expected) return shiftIsoDateBy(date, 1);
  if ((actual + 6) % 7 === expected) return shiftIsoDateBy(date, -1);
  return date;
}

// isoDateWeekday now lives in ./lateness (imported above) so the parser and the
// lateness rule cannot drift apart on what "Sunday" means.

/** Lowercase + strip everything but letters/digits, so header formatting
 * variants ("Emp. ID", "EMP-ID", "employee id") all compare equal. */
function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Shorter aliases get a tighter tolerance so we don't fuzzy-match unrelated
 * short headers (e.g. "Day") — longer ones can absorb a couple of corrupted
 * characters (e.g. an export tool mangling ligatures/OCR-like text). */
function fuzzyThreshold(aliasLength: number): number {
  if (aliasLength <= 5) return 1;
  if (aliasLength <= 8) return 2;
  return 3;
}

function findColumn(headerRow: unknown[], field: keyof typeof HEADER_ALIASES): number {
  const aliases = HEADER_ALIASES[field];
  const normalized = headerRow.map(normalizeHeader);

  const exactIdx = normalized.findIndex((h) => aliases.includes(h));
  if (exactIdx !== -1) return exactIdx;

  // Fuzzy fallback: some export tools corrupt header text (ligature/OCR-style
  // glitches, e.g. "Employee ID" -> "Employee D", "Clock In" -> "Crock In").
  // Tolerate a small edit distance rather than failing outright.
  for (let i = 0; i < normalized.length; i++) {
    const h = normalized[i];
    if (!h) continue;
    for (const alias of aliases) {
      const threshold = fuzzyThreshold(alias.length);
      if (Math.abs(h.length - alias.length) > threshold) continue;
      if (levenshtein(h, alias) <= threshold) return i;
    }
  }
  return -1;
}

/** Excel may give a date as a JS Date (cellDates:true) or a raw string. */
function cellToIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    // Already 'YYYY-MM-DD'.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Excel may give a time as a JS Date (cellDates:true) or an 'HH:MM' string. */
function cellToHms(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(11, 19);
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
    }
  }
  return null;
}

function cellToMinutes(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Parse an uploaded workbook (raw bytes) into rows. Throws a plain Error with
 * a user-facing message on structural problems (missing columns, unreadable
 * file) — the caller surfaces it as a 400.
 */
export function parseAttendanceWorkbook(buffer: Buffer): SheetRow[] {
  // Refuse a decompression bomb BEFORE handing the bytes to the parser: the
  // route's 5 MB cap is on the compressed upload and says nothing about what it
  // expands to. Placed here rather than in the route so every caller inherits
  // it. See lib/platform/spreadsheetGuard.ts.
  assertSafeSpreadsheetEnvelope(buffer);

  // cellDates:true → dates/times arrive as JS Date, not Excel's serial number.
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  if (workbook.SheetNames.length === 0) throw new Error('The file has no sheets.');

  // Some export tools put the real table in a LATER sheet — e.g. a "Table 1" /
  // "Table 2" / "Table 3" workbook where only the last one actually has data
  // (the earlier ones are empty placeholder tabs). Try every sheet in order
  // and use the first one where a header row is actually found, rather than
  // assuming the data lives in SheetNames[0].
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
    });
    if (rows.length < 2) continue; // empty/near-empty sheet — try the next one

    // ZKTeco's export commonly has one or more rows ABOVE the real header —
    // a report title ("Total Time Card"), a company/branch name, the covered
    // date range, blank spacer rows, etc. — so the real header can land well
    // past row 0. Scan a generous window and pick the first row that actually
    // contains BOTH an Employee ID and a Date column (never just one, to avoid
    // mistaking a stray title/date-range row for the header).
    let headerIdx = -1;
    let headerRow: unknown[] = [];
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const candidate = rows[i] as unknown[];
      if (findColumn(candidate, 'employeeId') !== -1 && findColumn(candidate, 'date') !== -1) {
        headerIdx = i;
        headerRow = candidate;
        break;
      }
    }
    if (headerIdx === -1) continue; // no recognizable header in this sheet — try the next one

    const colEmployeeId = findColumn(headerRow, 'employeeId');
    const colDate = findColumn(headerRow, 'date');
    const colClockIn = findColumn(headerRow, 'clockIn');
    const colClockOut = findColumn(headerRow, 'clockOut');
    const colLate = findColumn(headerRow, 'lateMinutes');
    const colEarlyOut = findColumn(headerRow, 'earlyOutMinutes');
    const colWeekday = findColumn(headerRow, 'weekday');
    if (colLate === -1) {
      throw new Error('Could not find the "Late In(M)" column.');
    }

    const out: SheetRow[] = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      if (!r || r.every((c) => c === null || c === '')) continue; // blank row
      const employeeId = colEmployeeId !== -1 ? String(r[colEmployeeId] ?? '').trim() : '';
      let date = colDate !== -1 ? cellToIsoDate(r[colDate]) : null;
      if (date && colWeekday !== -1) {
        date = correctDateAgainstWeekday(date, r[colWeekday]);
      }
      if (!employeeId || !date) continue; // not a real data row
      out.push({
        employeeId,
        date,
        clockIn: colClockIn !== -1 ? cellToHms(r[colClockIn]) : null,
        clockOut: colClockOut !== -1 ? cellToHms(r[colClockOut]) : null,
        lateMinutes: cellToMinutes(r[colLate]),
        earlyOutMinutes: colEarlyOut !== -1 ? cellToMinutes(r[colEarlyOut]) : 0,
      });
    }
    return out;
  }

  throw new Error(
    'Could not find the header row (expected columns like "Employee ID" and "Date") in any sheet.'
  );
}

/** Earliest/latest date across `rows`, or null if empty. */
export function dateRangeOf(rows: SheetRow[]): { start: string; end: string } | null {
  let range: { start: string; end: string } | null = null;
  for (const r of rows) {
    if (!range) {
      range = { start: r.date, end: r.date };
    } else {
      if (r.date < range.start) range.start = r.date;
      if (r.date > range.end) range.end = r.date;
    }
  }
  return range;
}

/**
 * Shift every row's date by `offsetDays` (may be negative). Used when the
 * uploader corrects the detected date (e.g. the device clock was off) —
 * every row moves by the same amount, preserving the sheet's internal
 * day-to-day spacing.
 */
export function shiftRowDates(rows: SheetRow[], offsetDays: number): SheetRow[] {
  if (offsetDays === 0) return rows;
  return rows.map((r) => ({ ...r, date: shiftIsoDateBy(r.date, offsetDays) }));
}

/**
 * Resolve each employeeId (the ZKTeco/device Employee ID — see the "Employee
 * ID" field on the employee edit card) to the matching person's name, for one
 * company. Used to show the uploader a readable per-employee review table
 * before anything is stored — matching itself still happens by ID, never by
 * name (lib/platform/attendance.ts header comment).
 */
export async function resolveEmployeeNames(
  companyId: string,
  employeeIds: string[]
): Promise<Map<string, { userId: string; nameEn: string | null; nameAr: string | null }>> {
  const uniqueIds = Array.from(new Set(employeeIds));
  const out = new Map<string, { userId: string; nameEn: string | null; nameAr: string | null }>();
  if (uniqueIds.length === 0) return out;

  const supabase = getSupabaseAdmin();
  const memRes = await supabase
    .from('memberships')
    .select('user_id, zkteco_employee_id')
    .eq('company_id', companyId)
    .in('zkteco_employee_id', uniqueIds);
  if (memRes.error) throw new Error(memRes.error.message);
  const memRows =
    (memRes.data as { user_id: string; zkteco_employee_id: string }[] | null) ?? [];
  if (memRows.length === 0) return out;

  const userIds = Array.from(new Set(memRows.map((m) => m.user_id)));
  const usersRes = await supabase
    .from('app_users')
    .select('id, full_name_en, full_name_ar')
    .in('id', userIds);
  if (usersRes.error) throw new Error(usersRes.error.message);
  const userById = new Map(
    ((usersRes.data as
      | { id: string; full_name_en: string | null; full_name_ar: string | null }[]
      | null) ?? []
    ).map((u) => [u.id, u])
  );

  for (const m of memRows) {
    const u = userById.get(m.user_id);
    out.set(m.zkteco_employee_id, {
      userId: m.user_id,
      nameEn: u?.full_name_en ?? null,
      nameAr: u?.full_name_ar ?? null,
    });
  }
  return out;
}

/** Which of `dates` already have at least one attendance_records row for this company. */
export async function datesAlreadyRecorded(
  companyId: string,
  dates: string[]
): Promise<string[]> {
  const uniqueDates = Array.from(new Set(dates));
  if (uniqueDates.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_records')
    .select('date')
    .eq('company_id', companyId)
    .in('date', uniqueDates);
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as { date: string }[] | null) ?? [];
  return Array.from(new Set(rows.map((r) => r.date))).sort();
}

/**
 * Store parsed rows for one company. Rows whose employeeId has no
 * memberships.zkteco_employee_id match are skipped and listed back.
 * Re-uploading (e.g. a corrected sheet) simply overwrites same-day rows —
 * callers should confirm with the uploader first via datesAlreadyRecorded().
 */
export async function storeAttendanceRows(
  companyId: string,
  uploadedBy: string,
  rows: SheetRow[],
  /** The attendance_uploads row these rows came from, so the whole upload can
   * later be re-opened for editing or deleted as a unit. */
  uploadId?: string | null
): Promise<AttendanceUploadResult> {
  const supabase = getSupabaseAdmin();

  const uniqueZktecoIds = Array.from(new Set(rows.map((r) => r.employeeId)));
  const memRes = await supabase
    .from('memberships')
    .select('user_id, zkteco_employee_id')
    .eq('company_id', companyId)
    .in('zkteco_employee_id', uniqueZktecoIds);
  if (memRes.error) throw new Error(memRes.error.message);
  const userIdByZktecoId = new Map<string, string>(
    ((memRes.data as { user_id: string; zkteco_employee_id: string }[] | null) ?? []).map(
      (m) => [m.zkteco_employee_id, m.user_id]
    )
  );

  // Each matched employee's own schedule, so lateness is measured against the
  // start time configured for THEM rather than taken from the sheet's own
  // Late In(M) column. Fetched once for the whole upload.
  const schedules = await getWorkingSchedulesForUsers(
    companyId,
    Array.from(userIdByZktecoId.values())
  );
  const NO_SCHEDULE: WorkSchedule = { workingDays: null, startTime: null };

  /*
    THE SCHEDULE IN FORCE ON EACH ROW'S OWN DATE (#42).

    A membership can describe its week as intervals — office or online, several
    a day, different by weekday. Where it does, that outranks the single start
    time: lateness is measured from the first OFFICE block of the day, because
    the device can only see somebody physically present. Without this, a day
    that opens with three hours online and reaches the office at 14:30 is
    reported five and a half hours late.

    One query for the whole sheet, filtered per row. Judging every row against
    TODAY's schedule would defeat the validity dates — reopening last term's
    sheet would re-score it on this term's hours.
  */
  const sheetDates = rows.map((r) => r.date).filter(Boolean).sort();
  const blocksFor =
    sheetDates.length > 0
      ? await scheduleBlockLookup(
          companyId,
          Array.from(userIdByZktecoId.values()),
          sheetDates[0],
          sheetDates[sheetDates.length - 1]
        )
      : () => [];

  const unmatchedZktecoIds = new Set<string>();
  const upsertRows: Record<string, unknown>[] = [];
  for (const r of rows) {
    const userId = userIdByZktecoId.get(r.employeeId);
    if (!userId) {
      unmatchedZktecoIds.add(r.employeeId);
      continue;
    }
    upsertRows.push({
      user_id: userId,
      company_id: companyId,
      date: r.date,
      clock_in: r.clockIn,
      clock_out: r.clockOut,
      day_status: r.dayStatus ?? 'present',
      late_minutes: computeLateMinutes({
        date: r.date,
        clockIn: r.clockIn,
        sheetLateMinutes: r.lateMinutes,
        schedule: {
          ...(schedules.get(userId) ?? NO_SCHEDULE),
          blocks: blocksFor(userId, r.date),
        },
        dayStatus: r.dayStatus,
      }),
      // Approved leave is not an early finish.
      early_out_minutes: r.dayStatus === 'vacation' ? 0 : r.earlyOutMinutes,
      uploaded_by: uploadedBy,
      uploaded_at: new Date().toISOString(),
      ...(uploadId ? { upload_id: uploadId } : {}),
    });
  }

  if (upsertRows.length > 0) {
    const res = await supabase
      .from('attendance_records')
      .upsert(upsertRows, { onConflict: 'user_id,date' });
    if (res.error) throw new Error(res.error.message);
  }

  return {
    totalRows: rows.length,
    matchedRows: upsertRows.length,
    unmatchedZktecoIds: Array.from(unmatchedZktecoIds),
    dateRange: dateRangeOf(rows),
    // Note: `excused_minutes` is deliberately absent from the upsert payload.
    // ON CONFLICT only overwrites the columns listed, so re-uploading a day
    // keeps any time an approved objection already excused on it.
    userIdByZktecoId,
  };
}

// ---- Reporting --------------------------------------------------------------

/**
 * The last day of a period, as a day-of-month.
 *
 * 25 means a period runs 25th → 25th INCLUSIVE, as specified: "25 July –
 * 25 August is August".
 *
 * ⚠️ ONE-DAY OVERLAP. Because each period also STARTS on a 25th, the 25th
 * belongs to two of them: 25 Aug closes the August period and opens the
 * September one, so a late arrival that day is counted in both totals. Set
 * this to 24 for periods that tile exactly with no day counted twice.
 */
const PERIOD_END_DAY = 25;

/**
 * The 25th→25th "attendance period" containing `now`, as inclusive ISO dates.
 *
 * Resolved against the FIRM'S calendar day, not UTC: Qatar is UTC+3, so for the
 * three hours after local midnight on the 25th the UTC date is still the 24th,
 * and the period would flip a day late — dropping the new period's first day
 * from every summary that ran in that window.
 */
export function currentAttendancePeriod(now: Date = new Date()): {
  start: string;
  end: string;
} {
  const parts = businessDateParts(now);
  const y = parts.year;
  const m = parts.month - 1; // 0-based, for Date.UTC
  const d = parts.day;
  // Period start: the 25th of this month if we're on/after it, else last month's 25th.
  const startMonth = d >= 25 ? m : m - 1;
  const start = new Date(Date.UTC(y, startMonth, 25));
  const end = new Date(Date.UTC(y, startMonth + 1, PERIOD_END_DAY));
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/**
 * Remove a day's APPROVED objection minutes (attendance_records.excused_minutes)
 * from that day's late/early-out pair.
 *
 * The objection asks for time to come off the day's TOTAL, not off one specific
 * column — so this drains late first and spills the remainder into early-out,
 * each floored at zero. Totals are reported per column, which is the only
 * reason the split has to be decided at all.
 */
function applyExcused(
  late: number,
  early: number,
  excused: number
): { late: number; early: number } {
  const ex = Math.max(0, excused);
  if (ex === 0) return { late, early };
  return {
    late: Math.max(0, late - ex),
    early: Math.max(0, early - Math.max(0, ex - late)),
  };
}

export interface EmployeeAttendanceSummary {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  totalLateMinutes: number;
  totalEarlyOutMinutes: number;
}

/** Per-employee total late/early-out minutes in the CURRENT period, for one company.
 * Only counts a day toward the total if it's one of that employee's configured
 * working days (Employees tab schedule) — an employee with no schedule set has
 * every day counted, same as before this filter existed. */
export async function attendanceSummaryForCompany(
  companyId: string
): Promise<EmployeeAttendanceSummary[]> {
  const { start, end } = currentAttendancePeriod();
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_records')
    .select(
      'user_id, date, clock_in, late_minutes, early_out_minutes, day_status, excused_minutes'
    )
    .eq('company_id', companyId)
    .gte('date', start)
    .lte('date', end);
  if (res.error) throw new Error(res.error.message);
  const rows =
    (res.data as
      | {
          user_id: string;
          date: string;
          clock_in: string | null;
          late_minutes: number;
          early_out_minutes: number;
          day_status: DayStatus | null;
          excused_minutes: number | null;
        }[]
      | null) ?? [];
  if (rows.length === 0) return [];

  const schedules = await getWorkingSchedulesForUsers(
    companyId,
    rows.map((r) => r.user_id)
  );
  // THE BLOCK SCHEDULE BELONGS HERE TOO (#42).
  //
  // This summary recomputes lateness on read, and it has to reach the same
  // answer as the upload — which resolves blocks per row. Without them a person
  // described by intervals was scored twice wrong: their office arrival
  // measured against a start time that no longer means anything, AND whole days
  // dropped by the working-days guard below, because the older working_days
  // list disagrees with the week their blocks actually describe.
  const blocksFor = await scheduleBlockLookup(
    companyId,
    rows.map((r) => r.user_id),
    start,
    end
  );

  const totalsByUser = new Map<string, { late: number; early: number }>();
  for (const r of rows) {
    const base = schedules.get(r.user_id) ?? { workingDays: null, startTime: null };
    const blocks = blocksFor(r.user_id, r.date);
    const schedule = { ...base, blocks };
    // Skip non-working days entirely — that zeroes EARLY OUT too, which
    // computeLateMinutes cannot do on its own.
    //
    // Blocks answer this on their own where they exist: a day they do not
    // cover is not a working day, whatever the older list says.
    const worked =
      blocks.length > 0
        ? hasAnyBlock(blocks, isoDateWeekday(r.date))
        : !base.workingDays ||
          base.workingDays.length === 0 ||
          base.workingDays.includes(isoDateWeekday(r.date));
    if (!worked) continue;
    const cur = totalsByUser.get(r.user_id) ?? { late: 0, early: 0 };
    // Recomputed on READ, not just trusted from the row. An admin who fixes an
    // employee's start time expects the totals to correct themselves; without
    // this they would have to re-upload the sheet to see any change.
    const rawLate = computeLateMinutes({
      date: r.date,
      clockIn: r.clock_in,
      sheetLateMinutes: r.late_minutes ?? 0,
      schedule,
      dayStatus: r.day_status,
    });
    // Vacation is approved leave, so an early finish on one is not early-out.
    const rawEarly = r.day_status === 'vacation' ? 0 : r.early_out_minutes ?? 0;
    // Time an approved objection has excused comes off here, for the same
    // reason lateness is recomputed here: the stored minutes are inputs.
    const adj = applyExcused(rawLate, rawEarly, r.excused_minutes ?? 0);
    cur.late += adj.late;
    cur.early += adj.early;
    totalsByUser.set(r.user_id, cur);
  }
  if (totalsByUser.size === 0) return [];

  const userIds = Array.from(totalsByUser.keys());
  const usersRes = await supabase
    .from('app_users')
    .select('id, full_name_en, full_name_ar')
    .in('id', userIds);
  if (usersRes.error) throw new Error(usersRes.error.message);
  const userById = new Map<
    string,
    { full_name_en: string | null; full_name_ar: string | null }
  >(
    ((usersRes.data as { id: string; full_name_en: string | null; full_name_ar: string | null }[] | null) ?? []).map(
      (u) => [u.id, u]
    )
  );

  return userIds
    .map((userId) => ({
      userId,
      nameEn: userById.get(userId)?.full_name_en ?? null,
      nameAr: userById.get(userId)?.full_name_ar ?? null,
      totalLateMinutes: totalsByUser.get(userId)?.late ?? 0,
      totalEarlyOutMinutes: totalsByUser.get(userId)?.early ?? 0,
    }))
    .sort((a, b) => b.totalLateMinutes - a.totalLateMinutes);
}

export interface MyAttendanceSummary {
  /**
   * The most recent WORKING day this person has an attendance record for —
   * not literally yesterday.
   *
   * Someone working Sunday–Thursday arrives on Sunday to find that "yesterday"
   * was Saturday, which they do not work and have no record for. Their
   * Thursday mark would then be permanently unobjectable. This walks back to
   * the last day they actually worked, so Thursday is still reachable on
   * Sunday. Null when they have no record in the window at all.
   */
  lastRecordedDate: string | null;
  /** Lateness on `lastRecordedDate`. Named "yesterday*" for continuity. */
  yesterdayLateMinutes: number;
  yesterdayEarlyOutMinutes: number;
  /** True when `lastRecordedDate` is set (so the UI can distinguish "on time"
   * from "no data / didn't work that day"). */
  hasYesterdayRecord: boolean;
  periodTotalLateMinutes: number;
  periodTotalEarlyOutMinutes: number;
  periodStart: string;
  periodEnd: string;
}

/** The CALLER's own lateness — yesterday + running total for the current period.
 * Only counts a day if it's one of the caller's configured working days for
 * that company (Employees tab schedule) — no schedule set means every day
 * counts, same as before this filter existed. */
export async function myAttendanceSummary(userId: string): Promise<MyAttendanceSummary> {
  const { start, end } = currentAttendancePeriod();
  const supabase = getSupabaseAdmin();

  // Everything strictly before today, most recent first. The first row that
  // falls on one of this person's working days is the day the banner talks
  // about — see MyAttendanceSummary.lastRecordedDate for why it is not simply
  // yesterday. Capped at a handful of rows: after a long break the point is
  // the last day worked, not an audit trail.
  //
  // The firm's day, not UTC: for the three hours after local midnight, UTC is
  // still yesterday, and "before today" would then include yesterday's own row
  // and report it as the last working day while the person is still in it.
  const today = todayIso();

  const [recentRes, periodRes] = await Promise.all([
    supabase
      .from('attendance_records')
      .select(
        'company_id, date, clock_in, late_minutes, early_out_minutes, day_status, excused_minutes'
      )
      .eq('user_id', userId)
      .lt('date', today)
      .order('date', { ascending: false })
      .limit(14),
    supabase
      .from('attendance_records')
      .select(
        'company_id, date, clock_in, late_minutes, early_out_minutes, day_status, excused_minutes'
      )
      .eq('user_id', userId)
      .gte('date', start)
      .lte('date', end),
  ]);
  if (recentRes.error) throw new Error(recentRes.error.message);
  if (periodRes.error) throw new Error(periodRes.error.message);

  type Row = {
    company_id: string;
    date: string;
    clock_in: string | null;
    late_minutes: number;
    early_out_minutes: number;
    day_status: DayStatus | null;
    excused_minutes: number | null;
  };
  const recentRows = (recentRes.data as Row[] | null) ?? [];
  const periodRowsRaw = (periodRes.data as Row[] | null) ?? [];

  const companyIds = Array.from(
    new Set([
      ...recentRows.map((r) => r.company_id),
      ...periodRowsRaw.map((r) => r.company_id),
    ])
  );
  const scheduleByCompany = new Map<string, WorkSchedule>();
  // Block lookups, one per company, over the whole span being summarised — the
  // stored figure and this recomputation must agree, and they only do if both
  // judge a date against the schedule in force ON THAT DATE (#42).
  const blockLookupByCompany = new Map<
    string,
    (userId: string, date: string) => ScheduleBlock[]
  >();
  const allDates = [...recentRows, ...periodRowsRaw]
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  await Promise.all(
    companyIds.map(async (companyId) => {
      const map = await getWorkingSchedulesForUsers(companyId, [userId]);
      scheduleByCompany.set(
        companyId,
        map.get(userId) ?? { workingDays: null, startTime: null }
      );
      if (allDates.length > 0) {
        blockLookupByCompany.set(
          companyId,
          await scheduleBlockLookup(
            companyId,
            [userId],
            allDates[0],
            allDates[allDates.length - 1]
          )
        );
      }
    })
  );
  const blocksFor = (companyId: string, date: string): ScheduleBlock[] =>
    blockLookupByCompany.get(companyId)?.(userId, date) ?? [];
  const scheduleFor = (companyId: string, date: string): WorkSchedule => ({
    ...(scheduleByCompany.get(companyId) ?? { workingDays: null, startTime: null }),
    blocks: blocksFor(companyId, date),
  });
  const isWorkingDay = (companyId: string, date: string): boolean => {
    // A block schedule answers this on its own: a day it does not cover is not
    // a working day, whatever the older working_days list says.
    const blocks = blocksFor(companyId, date);
    if (blocks.length > 0) return hasAnyBlock(blocks, isoDateWeekday(date));
    const { workingDays } = scheduleByCompany.get(companyId) ?? {
      workingDays: null,
      startTime: null,
    };
    return (
      !workingDays ||
      workingDays.length === 0 ||
      workingDays.includes(isoDateWeekday(date))
    );
  };
  /** Same rule the manager-facing summary applies, so the two always agree —
   * lateness recomputed from the schedule, then approved objection minutes
   * drained off the day (late first, remainder from early-out). */
  const adjustedOf = (r: Row): { late: number; early: number } =>
    applyExcused(
      computeLateMinutes({
        date: r.date,
        clockIn: r.clock_in,
        sheetLateMinutes: r.late_minutes ?? 0,
        schedule: scheduleFor(r.company_id, r.date),
        dayStatus: r.day_status,
      }),
      r.day_status === 'vacation' ? 0 : r.early_out_minutes ?? 0,
      r.excused_minutes ?? 0
    );

  // The most recent day that is actually one of THIS person's working days.
  // Rows are already newest-first, so the first match is the day to report.
  const lastRow =
    recentRows.find((r) => isWorkingDay(r.company_id, r.date)) ?? null;
  const yesterdayCounts = lastRow !== null;
  const periodRows = periodRowsRaw.filter((r) => isWorkingDay(r.company_id, r.date));

  const lastAdjusted = lastRow ? adjustedOf(lastRow) : null;

  return {
    lastRecordedDate: lastRow?.date ?? null,
    yesterdayLateMinutes: lastAdjusted?.late ?? 0,
    yesterdayEarlyOutMinutes: lastAdjusted?.early ?? 0,
    hasYesterdayRecord: yesterdayCounts,
    periodTotalLateMinutes: periodRows.reduce((sum, r) => sum + adjustedOf(r).late, 0),
    periodTotalEarlyOutMinutes: periodRows.reduce(
      (sum, r) => sum + adjustedOf(r).early,
      0
    ),
    periodStart: start,
    periodEnd: end,
  };
}


// ---- Uploaded files ---------------------------------------------------------

export interface AttendanceUploadSummary {
  id: string;
  fileName: string;
  uploadedBy: string | null;
  uploadedByNameEn: string | null;
  uploadedByNameAr: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  totalRows: number;
  matchedRows: number;
  recordCount: number;
  createdAt: string;
}

/**
 * Archive the workbook itself, before its rows are stored, and return the id
 * the rows are then tagged with. Kept as base64 in Postgres rather than in an
 * object store: a time-card export is a few hundred KB and this codebase has
 * no bucket to put it in, so introducing one for this alone isn't worth it.
 */
export async function recordAttendanceUpload(input: {
  companyId: string;
  uploadedBy: string;
  fileName: string;
  fileBase64: string;
  dateStart: string | null;
  dateEnd: string | null;
  totalRows: number;
}): Promise<string> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_uploads')
    .insert({
      company_id: input.companyId,
      uploaded_by: input.uploadedBy,
      file_name: input.fileName,
      file_base64: input.fileBase64,
      date_start: input.dateStart,
      date_end: input.dateEnd,
      total_rows: input.totalRows,
      matched_rows: 0,
    })
    .select('id')
    .single();
  if (res.error) throw new Error(res.error.message);
  return (res.data as { id: string }).id;
}

/** Fill in what the commit actually managed to match/cover. */
export async function finalizeAttendanceUpload(
  uploadId: string,
  patch: { matchedRows: number; dateStart: string | null; dateEnd: string | null }
): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from('attendance_uploads')
    .update({
      matched_rows: patch.matchedRows,
      date_start: patch.dateStart,
      date_end: patch.dateEnd,
    })
    .eq('id', uploadId);
}

/** Every archived upload for a company, newest first (never the file bytes —
 * those are streamed one at a time by the download route). */
export async function listAttendanceUploads(
  companyId: string
): Promise<AttendanceUploadSummary[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_uploads')
    .select(
      'id, file_name, uploaded_by, date_start, date_end, total_rows, matched_rows, created_at'
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (res.error) {
    // DEPLOY SAFETY: the Attendance page must still render before migration #28.
    if ((res.error as { code?: string }).code === '42P01') return [];
    throw new Error(res.error.message);
  }
  const rows =
    (res.data as
      | {
          id: string;
          file_name: string;
          uploaded_by: string | null;
          date_start: string | null;
          date_end: string | null;
          total_rows: number;
          matched_rows: number;
          created_at: string;
        }[]
      | null) ?? [];
  if (rows.length === 0) return [];

  const uploaderIds = Array.from(
    new Set(rows.map((r) => r.uploaded_by).filter((x): x is string => !!x))
  );
  const nameById = new Map<
    string,
    { full_name_en: string | null; full_name_ar: string | null }
  >();
  if (uploaderIds.length > 0) {
    const usersRes = await supabase
      .from('app_users')
      .select('id, full_name_en, full_name_ar')
      .in('id', uploaderIds);
    for (const u of (usersRes.data as
      | { id: string; full_name_en: string | null; full_name_ar: string | null }[]
      | null) ?? []) {
      nameById.set(u.id, u);
    }
  }

  // How many attendance days each file is still responsible for — the number
  // that would disappear if it were deleted.
  const countRes = await supabase
    .from('attendance_records')
    .select('upload_id')
    .eq('company_id', companyId)
    .in(
      'upload_id',
      rows.map((r) => r.id)
    );
  const countByUpload = new Map<string, number>();
  for (const r of (countRes.data as { upload_id: string | null }[] | null) ?? []) {
    if (r.upload_id) countByUpload.set(r.upload_id, (countByUpload.get(r.upload_id) ?? 0) + 1);
  }

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    uploadedBy: r.uploaded_by,
    uploadedByNameEn: r.uploaded_by ? nameById.get(r.uploaded_by)?.full_name_en ?? null : null,
    uploadedByNameAr: r.uploaded_by ? nameById.get(r.uploaded_by)?.full_name_ar ?? null : null,
    dateStart: r.date_start,
    dateEnd: r.date_end,
    totalRows: r.total_rows,
    matchedRows: r.matched_rows,
    recordCount: countByUpload.get(r.id) ?? 0,
    createdAt: r.created_at,
  }));
}

/** The stored workbook, for the download button. Scoped by company so an id
 * from another firm cannot be fetched. */
export async function getAttendanceUploadFile(
  companyId: string,
  uploadId: string
): Promise<{ fileName: string; buffer: Buffer } | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_uploads')
    .select('file_name, file_base64')
    .eq('company_id', companyId)
    .eq('id', uploadId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { file_name: string; file_base64: string } | null;
  if (!row) return null;
  return { fileName: row.file_name, buffer: Buffer.from(row.file_base64, 'base64') };
}

/**
 * The days this upload stored, shaped exactly like freshly-parsed sheet rows
 * so the SAME review table can edit them. Reads back the STORED records, not
 * the original file — corrections made on a previous edit must survive.
 */
export async function attendanceUploadRowsForEdit(
  companyId: string,
  uploadId: string
): Promise<{
  rows: (SheetRow & {
    nameEn: string | null;
    nameAr: string | null;
    matched: boolean;
  })[];
  dateRange: { start: string; end: string } | null;
} | null> {
  const supabase = getSupabaseAdmin();
  const uploadRes = await supabase
    .from('attendance_uploads')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', uploadId)
    .maybeSingle();
  if (uploadRes.error) throw new Error(uploadRes.error.message);
  if (!uploadRes.data) return null;

  const recRes = await supabase
    .from('attendance_records')
    .select('user_id, date, clock_in, clock_out, late_minutes, early_out_minutes, day_status')
    .eq('company_id', companyId)
    .eq('upload_id', uploadId)
    .order('date', { ascending: true });
  if (recRes.error) throw new Error(recRes.error.message);
  const records =
    (recRes.data as
      | {
          user_id: string;
          date: string;
          clock_in: string | null;
          clock_out: string | null;
          late_minutes: number;
          early_out_minutes: number;
          day_status: DayStatus | null;
        }[]
      | null) ?? [];
  if (records.length === 0) return { rows: [], dateRange: null };

  const userIds = Array.from(new Set(records.map((r) => r.user_id)));
  const [memRes, usersRes] = await Promise.all([
    supabase
      .from('memberships')
      .select('user_id, zkteco_employee_id')
      .eq('company_id', companyId)
      .in('user_id', userIds),
    supabase.from('app_users').select('id, full_name_en, full_name_ar').in('id', userIds),
  ]);
  if (memRes.error) throw new Error(memRes.error.message);
  if (usersRes.error) throw new Error(usersRes.error.message);
  const zktecoByUser = new Map<string, string | null>(
    ((memRes.data as { user_id: string; zkteco_employee_id: string | null }[] | null) ?? []).map(
      (m) => [m.user_id, m.zkteco_employee_id]
    )
  );
  const userById = new Map<
    string,
    { full_name_en: string | null; full_name_ar: string | null }
  >(
    ((usersRes.data as
      | { id: string; full_name_en: string | null; full_name_ar: string | null }[]
      | null) ?? []).map((u) => [u.id, u])
  );

  const rows = records.map((r) => {
    const zkteco = zktecoByUser.get(r.user_id) ?? '';
    const u = userById.get(r.user_id);
    return {
      employeeId: zkteco ?? '',
      date: r.date,
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      lateMinutes: r.late_minutes ?? 0,
      earlyOutMinutes: r.early_out_minutes ?? 0,
      dayStatus: (r.day_status ?? 'present') as DayStatus,
      nameEn: u?.full_name_en ?? null,
      nameAr: u?.full_name_ar ?? null,
      matched: true,
    };
  });
  return { rows, dateRange: dateRangeOf(rows) };
}

/**
 * Delete a whole upload: the attendance days it stored, then the archived file.
 * The days go too — the point of the button is to undo the upload, and leaving
 * orphaned records behind would silently keep counting against employees.
 */
export async function deleteAttendanceUpload(
  companyId: string,
  uploadId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const found = await supabase
    .from('attendance_uploads')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', uploadId)
    .maybeSingle();
  if (found.error) throw new Error(found.error.message);
  if (!found.data) return false;

  // The days this upload is about to remove, so any objection still awaiting a
  // decision on one of them can be withdrawn with it — an approver must never
  // be asked to rule on a day that no longer exists. Decided objections stay
  // as history.
  const affected = await supabase
    .from('attendance_records')
    .select('user_id, date')
    .eq('company_id', companyId)
    .eq('upload_id', uploadId);
  if (affected.error) throw new Error(affected.error.message);
  const days = (affected.data as { user_id: string; date: string }[] | null) ?? [];

  const delRecs = await supabase
    .from('attendance_records')
    .delete()
    .eq('company_id', companyId)
    .eq('upload_id', uploadId);
  if (delRecs.error) throw new Error(delRecs.error.message);

  if (days.length > 0) {
    const delObj = await supabase
      .from('attendance_objections')
      .delete()
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .in('user_id', Array.from(new Set(days.map((d) => d.user_id))))
      .in('date', Array.from(new Set(days.map((d) => d.date))));
    if (delObj.error) throw new Error(delObj.error.message);
  }

  const delUpload = await supabase
    .from('attendance_uploads')
    .delete()
    .eq('company_id', companyId)
    .eq('id', uploadId);
  if (delUpload.error) throw new Error(delUpload.error.message);
  return true;
}

// ---- Objections -------------------------------------------------------------

export type ObjectionStatus = 'pending' | 'approved' | 'rejected';

export interface PendingObjection {
  id: string;
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  date: string;
  comment: string;
  requestedMinutes: number;
  raisedByNameEn: string | null;
  raisedByNameAr: string | null;
  createdAt: string;
  /** What the day currently counts for, so the approver decides with the same
   * numbers the summary shows. */
  dayLateMinutes: number;
  dayEarlyOutMinutes: number;
}

/** The ONE manager the admin designated to decide this company's objections. */
export async function objectionApproverId(companyId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('companies')
    .select('attendance_objection_approver_id')
    .eq('id', companyId)
    .maybeSingle();
  if (res.error) {
    if ((res.error as { code?: string }).code === '42703') return null;
    throw new Error(res.error.message);
  }
  return (res.data as { attendance_objection_approver_id: string | null } | null)
    ?.attendance_objection_approver_id ?? null;
}

/**
 * File one objection per disputed day, raised by the sheet uploader, and tell
 * the approver once. Recording always wins over notifying (best-effort send,
 * matching the mentions pattern).
 */
export async function createUploaderObjections(input: {
  companyId: string;
  raisedBy: string;
  raisedByNameEn: string | null;
  raisedByNameAr: string | null;
  approverId: string;
  items: { userId: string; date: string; minutes: number; comment: string }[];
}): Promise<number> {
  if (input.items.length === 0) return 0;
  const supabase = getSupabaseAdmin();
  const insRes = await supabase.from('attendance_objections').insert(
    input.items.map((it) => ({
      user_id: it.userId,
      company_id: input.companyId,
      date: it.date,
      comment: it.comment,
      requested_minutes: it.minutes,
      status: 'pending',
      approver_id: input.approverId,
      raised_by: input.raisedBy,
      notified_manager_ids: [input.approverId],
    }))
  );
  if (insRes.error) throw new Error(insRes.error.message);

  const who = input.raisedByNameEn || input.raisedByNameAr || 'The attendance uploader';
  const whoAr = input.raisedByNameAr || input.raisedByNameEn || 'رافع كشف الحضور';
  await insertNotifications([
    {
      userId: input.approverId,
      companyId: input.companyId,
      taskId: null,
      type: 'attendance_objection' as const,
      level: null,
      messageEn:
        input.items.length === 1
          ? `${who} raised an attendance objection for ${input.items[0].date} — your approval is needed.`
          : `${who} raised ${input.items.length} attendance objections — your approval is needed.`,
      messageAr:
        input.items.length === 1
          ? `قدّم ${whoAr} اعتراضًا على الحضور بتاريخ ${input.items[0].date} — بانتظار موافقتك.`
          : `قدّم ${whoAr} ${input.items.length} اعتراضات على الحضور — بانتظار موافقتك.`,
    },
  ]);
  return input.items.length;
}

/** Everything still awaiting a decision in this company, newest first. */
export async function listPendingObjections(
  companyId: string
): Promise<PendingObjection[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_objections')
    .select('id, user_id, date, comment, requested_minutes, raised_by, created_at')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200);
  if (res.error) {
    if ((res.error as { code?: string }).code === '42703') return [];
    throw new Error(res.error.message);
  }
  const rows =
    (res.data as
      | {
          id: string;
          user_id: string;
          date: string;
          comment: string;
          requested_minutes: number;
          raised_by: string | null;
          created_at: string;
        }[]
      | null) ?? [];
  if (rows.length === 0) return [];

  const userIds = Array.from(
    new Set([
      ...rows.map((r) => r.user_id),
      ...rows.map((r) => r.raised_by).filter((x): x is string => !!x),
    ])
  );
  const [usersRes, recRes, schedules, objectionBlocksFor] = await Promise.all([
    supabase.from('app_users').select('id, full_name_en, full_name_ar').in('id', userIds),
    supabase
      .from('attendance_records')
      .select('user_id, date, clock_in, late_minutes, early_out_minutes, day_status, excused_minutes')
      .eq('company_id', companyId)
      .in('user_id', Array.from(new Set(rows.map((r) => r.user_id))))
      .in('date', Array.from(new Set(rows.map((r) => r.date)))),
    getWorkingSchedulesForUsers(companyId, rows.map((r) => r.user_id)),
    // Blocks too (#42), or the number a manager weighs an objection against
    // differs from the one on the summary they came from.
    (async () => {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      if (dates.length === 0) {
        return () => [] as ScheduleBlock[];
      }
      return scheduleBlockLookup(
        companyId,
        rows.map((r) => r.user_id),
        dates[0],
        dates[dates.length - 1]
      );
    })(),
  ]);
  if (usersRes.error) throw new Error(usersRes.error.message);
  const userById = new Map<
    string,
    { full_name_en: string | null; full_name_ar: string | null }
  >(
    ((usersRes.data as
      | { id: string; full_name_en: string | null; full_name_ar: string | null }[]
      | null) ?? []).map((u) => [u.id, u])
  );
  const recByKey = new Map<
    string,
    {
      clock_in: string | null;
      late_minutes: number;
      early_out_minutes: number;
      day_status: DayStatus | null;
      excused_minutes: number | null;
    }
  >();
  for (const r of (recRes.data as
    | {
        user_id: string;
        date: string;
        clock_in: string | null;
        late_minutes: number;
        early_out_minutes: number;
        day_status: DayStatus | null;
        excused_minutes: number | null;
      }[]
    | null) ?? []) {
    recByKey.set(`${r.user_id}|${r.date}`, r);
  }

  return rows.map((r) => {
    const rec = recByKey.get(`${r.user_id}|${r.date}`);
    const schedule = {
      ...(schedules.get(r.user_id) ?? { workingDays: null, startTime: null }),
      blocks: objectionBlocksFor(r.user_id, r.date),
    };
    const adj = rec
      ? applyExcused(
          computeLateMinutes({
            date: r.date,
            clockIn: rec.clock_in,
            sheetLateMinutes: rec.late_minutes ?? 0,
            schedule,
            dayStatus: rec.day_status,
          }),
          rec.day_status === 'vacation' ? 0 : rec.early_out_minutes ?? 0,
          rec.excused_minutes ?? 0
        )
      : { late: 0, early: 0 };
    const raiser = r.raised_by ? userById.get(r.raised_by) : undefined;
    return {
      id: r.id,
      userId: r.user_id,
      nameEn: userById.get(r.user_id)?.full_name_en ?? null,
      nameAr: userById.get(r.user_id)?.full_name_ar ?? null,
      date: r.date,
      comment: r.comment,
      requestedMinutes: r.requested_minutes ?? 0,
      raisedByNameEn: raiser?.full_name_en ?? null,
      raisedByNameAr: raiser?.full_name_ar ?? null,
      createdAt: r.created_at,
      dayLateMinutes: adj.late,
      dayEarlyOutMinutes: adj.early,
    };
  });
}

/**
 * Approve or reject one pending objection. Approving adds the requested
 * minutes to that day's excused_minutes — reporting subtracts them on read
 * (see applyExcused); rejecting leaves the day exactly as recorded.
 *
 * Returns 'not-found' when the id isn't a pending objection of this company,
 * so the caller can 404 without leaking whether it exists elsewhere.
 */
export async function decideObjection(input: {
  companyId: string;
  objectionId: string;
  deciderId: string;
  approve: boolean;
}): Promise<'ok' | 'not-found'> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('attendance_objections')
    .select('id, user_id, date, requested_minutes, status, raised_by')
    .eq('company_id', input.companyId)
    .eq('id', input.objectionId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as
    | {
        id: string;
        user_id: string;
        date: string;
        requested_minutes: number;
        status: string | null;
        raised_by: string | null;
      }
    | null;
  if (!row || row.status !== 'pending') return 'not-found';

  if (input.approve && row.requested_minutes > 0) {
    // Read-modify-write: a day can accumulate more than one approved objection.
    const recRes = await supabase
      .from('attendance_records')
      .select('id, excused_minutes')
      .eq('company_id', input.companyId)
      .eq('user_id', row.user_id)
      .eq('date', row.date)
      .maybeSingle();
    if (recRes.error) throw new Error(recRes.error.message);
    const rec = recRes.data as { id: string; excused_minutes: number | null } | null;
    if (rec) {
      const upd = await supabase
        .from('attendance_records')
        .update({ excused_minutes: (rec.excused_minutes ?? 0) + row.requested_minutes })
        .eq('id', rec.id);
      if (upd.error) throw new Error(upd.error.message);
    }
  }

  /*
    Claimed, then checked — the same discipline as the task transitions in
    lib/platform/tasks.ts. Without the chained select, an update that matched
    nothing because a concurrent decision already landed looked identical to
    one that matched, and this function went on to send the objector a second
    notification telling them their objection had been decided again.

    'not-found' is the right code for it rather than a new one: the route
    already renders that as "This objection has already been decided", which is
    precisely what happened.

    STILL OUTSTANDING HERE (audit CON-02): the excused minutes are credited
    ABOVE, before this claim. So a lost race is now reported, but the minutes
    were already added — the over-credit is detected, not prevented. Fixing
    that means moving the credit to after this block, which is a separate
    change and is deliberately not made here.
  */
  const upd = await supabase
    .from('attendance_objections')
    .update({
      status: input.approve ? 'approved' : 'rejected',
      decided_at: new Date().toISOString(),
      decided_by: input.deciderId,
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (upd.error) throw new Error(upd.error.message);
  if (!upd.data) return 'not-found';

  if (row.raised_by) {
    const h = Math.floor(row.requested_minutes / 60);
    const m = row.requested_minutes % 60;
    const amount = h > 0 ? `${h}h ${m}m` : `${m}m`;
    await insertNotifications([
      {
        userId: row.raised_by,
        companyId: input.companyId,
        taskId: null,
        type: 'attendance_objection' as const,
        level: null,
        messageEn: input.approve
          ? `Your attendance objection for ${row.date} was approved — ${amount} removed.`
          : `Your attendance objection for ${row.date} was rejected.`,
        messageAr: input.approve
          ? `تمت الموافقة على اعتراضك على الحضور بتاريخ ${row.date} — تم خصم ${amount}.`
          : `تم رفض اعتراضك على الحضور بتاريخ ${row.date}.`,
      },
    ]);
  }
  return 'ok';
}

/**
 * Apply an already-VALIDATED attendance upload: archive the workbook, store the
 * rows, finalise the archive record, then file any uploader objections.
 *
 * Extracted so the upload route and the approval executor run the SAME code.
 * A held upload is replayed from a parked payload days later, and duplicating
 * this orchestration would guarantee the two drift — the replayed import would
 * quietly stop matching what the direct one does.
 *
 * Assumes authorization, row validation, the objection permission and the
 * objection approver have ALL been checked by the caller.
 */
export interface ApplyUploadInput {
  companyId: string;
  actorId: string;
  actorNameEn: string | null;
  actorNameAr: string | null;
  rows: SheetRow[];
  uploadId: string | null;
  fileName: string | null;
  fileBase64: string | null;
  /** Objections whose dates are already shifted, keyed by device id. */
  objections: Array<{ employeeId: string; date: string; minutes: number; comment: string }>;
  /** Required only when `objections` is non-empty. */
  approverId: string | null;
}

export interface ApplyUploadResult {
  totalRows: number;
  matchedRows: number;
  unmatchedZktecoIds: string[];
  dateRange: { start: string; end: string } | null;
  objectionsCreated: number;
}

export async function applyAttendanceUpload(
  input: ApplyUploadInput
): Promise<ApplyUploadResult> {
  const { companyId, actorId, rows } = input;

  let uploadId = input.uploadId;
  if (!uploadId && input.fileName && input.fileBase64) {
    const range = dateRangeOf(rows);
    uploadId = await recordAttendanceUpload({
      companyId,
      uploadedBy: actorId,
      fileName: input.fileName,
      fileBase64: input.fileBase64,
      dateStart: range?.start ?? null,
      dateEnd: range?.end ?? null,
      totalRows: rows.length,
    });
  }

  const result = await storeAttendanceRows(companyId, actorId, rows, uploadId);

  if (uploadId) {
    const range = dateRangeOf(rows);
    await finalizeAttendanceUpload(uploadId, {
      matchedRows: result.matchedRows,
      dateStart: range?.start ?? null,
      dateEnd: range?.end ?? null,
    });
  }

  let objectionsCreated = 0;
  if (input.approverId && input.objections.length > 0) {
    // An objection about an employee the sheet never matched has nothing to
    // deduct from, so it is dropped rather than filed against nobody.
    const items = input.objections
      .map((o) => ({
        userId: result.userIdByZktecoId.get(o.employeeId) ?? null,
        date: o.date,
        minutes: o.minutes,
        comment: o.comment.trim(),
      }))
      .filter(
        (it): it is { userId: string; date: string; minutes: number; comment: string } =>
          it.userId !== null
      );
    objectionsCreated = await createUploaderObjections({
      companyId,
      raisedBy: actorId,
      raisedByNameEn: input.actorNameEn,
      raisedByNameAr: input.actorNameAr,
      approverId: input.approverId,
      items,
    });
  }

  return {
    totalRows: result.totalRows,
    matchedRows: result.matchedRows,
    unmatchedZktecoIds: result.unmatchedZktecoIds,
    dateRange: result.dateRange,
    objectionsCreated,
  };
}
