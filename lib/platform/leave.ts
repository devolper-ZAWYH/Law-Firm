import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { getWorkingSchedulesForUsers } from './workingHours';

/**
 * LEAVE PERIODS — booked, forward-looking employee leave.
 *
 * Two jobs, and only two:
 *   • answer "is this person away on date D" so a task cannot be assigned to
 *     someone who is not there (lib/platform/tasks.ts).
 *   • write those days down as attendance vacation days, so an uploaded sheet
 *     never counts a booked holiday as an absence (480 late minutes a day).
 *
 * Leave deliberately does NOT pause task timers or folder colour. A folder with
 * an away assignee keeps ageing; the approver is notified instead and is
 * expected to reassign.
 *
 * WHOLE DAYS ONLY. end_date is inclusive.
 *
 * DEPLOY SAFETY: every read degrades to empty and every write to a no-op if the
 * migration has not been applied yet (Postgres 42P01 — relation missing / 42703
 * — column missing), matching lib/platform/notifications.ts.
 */

export interface LeavePeriod {
  id: string;
  userId: string;
  companyId: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** 'YYYY-MM-DD', INCLUSIVE. */
  endDate: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface LeaveRow {
  id: string;
  user_id: string;
  company_id: string;
  start_date: string;
  end_date: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

const LEAVE_COLUMNS =
  'id, user_id, company_id, start_date, end_date, note, created_by, created_at';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Missing table/column — the migration has not run yet on this deploy. */
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === '42703';
}

function toPeriod(r: LeaveRow): LeavePeriod {
  return {
    id: r.id,
    userId: r.user_id,
    companyId: r.company_id,
    startDate: r.start_date,
    endDate: r.end_date,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/**
 * Re-exported so leave's callers keep one import. The firm's calendar day, not
 * UTC — see lib/platform/businessDay.ts for why that distinction matters here.
 */
export { todayIso } from './businessDay';

export async function listLeavePeriods(
  companyId: string,
  opts?: { userId?: string; from?: string }
): Promise<LeavePeriod[]> {
  const supabase = getSupabaseAdmin();
  let q = supabase.from('leave_periods').select(LEAVE_COLUMNS).eq('company_id', companyId);
  if (opts?.userId) q = q.eq('user_id', opts.userId);
  // Current AND upcoming: anything that has not finished yet.
  if (opts?.from) q = q.gte('end_date', opts.from);
  const res = await q.order('start_date', { ascending: true });
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return [];
    throw new Error(res.error.message);
  }
  return ((res.data as LeaveRow[] | null) ?? []).map(toPeriod);
}

/** Every 'YYYY-MM-DD' from start to end inclusive. */
function datesInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= last.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Write day_status='vacation' across the range, so a sheet uploaded later never
 * counts a booked holiday as an absence (which would be 480 late minutes a day).
 *
 * TWO THINGS ARE DELIBERATELY LEFT ALONE:
 *   • days the person does not work — there is nothing to excuse.
 *   • days that ALREADY have a record — the sheet is the record of what actually
 *     happened, and leave only fills days that have none.
 *
 * Best-effort: a failure here must not undo a leave booking that was already
 * accepted, so it is logged rather than thrown.
 */
async function markVacationDays(input: {
  companyId: string;
  userId: string;
  startDate: string;
  endDate: string;
  uploadedBy: string;
}): Promise<void> {
  const { companyId, userId, startDate, endDate, uploadedBy } = input;
  const supabase = getSupabaseAdmin();

  const schedules = await getWorkingSchedulesForUsers(companyId, [userId]);
  const workingDays = schedules.get(userId)?.workingDays ?? null;
  const days = datesInRange(startDate, endDate).filter((d) => {
    // Nothing configured → treated as "works every day", the same default the
    // lateness rule uses (lib/platform/workingHours.ts).
    if (!workingDays) return true;
    return workingDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  });
  if (days.length === 0) return;

  const existing = await supabase
    .from('attendance_records')
    .select('date')
    .eq('user_id', userId)
    .in('date', days);
  if (existing.error) {
    if (isMissingRelation(existing.error as { code?: string })) return;
    console.error('Leave vacation-day probe failed:', existing.error.message);
    return;
  }
  const taken = new Set(
    ((existing.data as { date: string }[] | null) ?? []).map((r) => r.date)
  );
  const rows = days
    .filter((d) => !taken.has(d))
    .map((date) => ({
      user_id: userId,
      company_id: companyId,
      date,
      clock_in: null,
      clock_out: null,
      late_minutes: 0,
      early_out_minutes: 0,
      day_status: 'vacation',
      uploaded_by: uploadedBy,
    }));
  if (rows.length === 0) return;

  const up = await supabase
    .from('attendance_records')
    .upsert(rows, { onConflict: 'user_id,date' });
  if (up.error && !isMissingRelation(up.error as { code?: string })) {
    console.error('Leave vacation-day write failed:', up.error.message);
  }
}

export type CreateLeaveResult =
  | { ok: true; period: LeavePeriod }
  | { ok: false; code: 'bad_input' | 'overlap' };

export async function createLeavePeriod(input: {
  companyId: string;
  userId: string;
  startDate: string;
  endDate: string;
  note: string | null;
  createdBy: string;
}): Promise<CreateLeaveResult> {
  const { companyId, userId, startDate, endDate, note, createdBy } = input;
  if (!companyId || !userId) return { ok: false, code: 'bad_input' };
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return { ok: false, code: 'bad_input' };
  }
  if (endDate < startDate) return { ok: false, code: 'bad_input' };

  const supabase = getSupabaseAdmin();

  // OVERLAP: two ranges overlap iff each starts on or before the other ends.
  // Rejected rather than merged so the person who booked it stays accountable
  // for exactly the dates they chose.
  const clash = await supabase
    .from('leave_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (clash.error) {
    if (!isMissingRelation(clash.error as { code?: string })) {
      throw new Error(clash.error.message);
    }
  } else if (((clash.data as unknown[] | null) ?? []).length > 0) {
    return { ok: false, code: 'overlap' };
  }

  const ins = await supabase
    .from('leave_periods')
    .insert({
      user_id: userId,
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
      note: note && note.trim().length > 0 ? note.trim() : null,
      created_by: createdBy,
    })
    .select(LEAVE_COLUMNS)
    .single();
  if (ins.error) throw new Error(ins.error.message);
  const period = toPeriod(ins.data as LeaveRow);
  await markVacationDays({
    companyId,
    userId,
    startDate,
    endDate,
    uploadedBy: createdBy,
  });
  return { ok: true, period };
}

/** Removes the period. False when nothing matched (wrong company, or gone). */
export async function deleteLeavePeriod(
  id: string,
  companyId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // Read the range first: once the row is gone there is nothing left to say
  // which attendance days the booking wrote.
  const found = await supabase
    .from('leave_periods')
    .select('user_id, start_date, end_date')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  if (found.error && !isMissingRelation(found.error as { code?: string })) {
    throw new Error(found.error.message);
  }
  const row = found.data as
    | { user_id: string; start_date: string; end_date: string }
    | null;

  const res = await supabase
    .from('leave_periods')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)
    .select('id');
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return false;
    throw new Error(res.error.message);
  }
  const removed = ((res.data as unknown[] | null) ?? []).length > 0;
  if (!removed || !row) return removed;

  // Only the placeholder rows this booking wrote: vacation, and no clock data.
  // A day the sheet has since filled in keeps whatever the sheet said.
  const cleanup = await supabase
    .from('attendance_records')
    .delete()
    .eq('user_id', row.user_id)
    .eq('company_id', companyId)
    .eq('day_status', 'vacation')
    .is('clock_in', null)
    .is('clock_out', null)
    .gte('date', row.start_date)
    .lte('date', row.end_date);
  if (cleanup.error && !isMissingRelation(cleanup.error as { code?: string })) {
    console.error('Leave vacation-day cleanup failed:', cleanup.error.message);
  }
  return true;
}

/** userId → the last day of their leave, for everyone away on `date`. */
export async function usersOnLeaveOn(
  companyId: string,
  date: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ISO_DATE.test(date)) return out;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('leave_periods')
    .select('user_id, end_date')
    .eq('company_id', companyId)
    .lte('start_date', date)
    .gte('end_date', date);
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return out;
    throw new Error(res.error.message);
  }
  for (const r of (res.data as { user_id: string; end_date: string }[] | null) ?? []) {
    // Overlaps are rejected at write time, so one row per person is expected;
    // the later end date wins if history ever contains an overlap anyway.
    const prev = out.get(r.user_id);
    if (!prev || r.end_date > prev) out.set(r.user_id, r.end_date);
  }
  return out;
}

/** The last day of this person's leave if they are away on `date`, else null. */
export async function leaveEndFor(
  userId: string,
  companyId: string,
  date: string
): Promise<string | null> {
  const away = await usersOnLeaveOn(companyId, date);
  return away.get(userId) ?? null;
}
