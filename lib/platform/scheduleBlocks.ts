import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import type { ScheduleBlock } from './lateness';

/**
 * WORK SCHEDULE BLOCKS — the week as intervals, each office or online (#42).
 *
 * Read the migration for why the single work_start_time could not hold a real
 * schedule. In short: the mode changes inside a day, days are split, the hours
 * differ by weekday, and the attendance device cannot see online work at all.
 *
 * DEPLOY SAFETY. New code reaches production before its migration runs, so a
 * missing table degrades to "no blocks" — which is precisely the pre-#42
 * behaviour, because the lateness rule falls back to the single start time when
 * the block list is empty. Nobody's attendance changes until somebody is
 * actually given a schedule here.
 */

/** A stored block, with the term it belongs to. */
export interface StoredScheduleBlock extends ScheduleBlock {
  id: string;
  /** 'YYYY-MM-DD'. */
  validFrom: string;
  /** 'YYYY-MM-DD', or null for open-ended. */
  validTo: string | null;
}

interface BlockRow {
  id: string;
  user_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  mode: string;
  valid_from: string;
  valid_to: string | null;
}

/** Postgres `time` round-trips with seconds; the UI speaks 'HH:MM'. */
function trimSeconds(value: string): string {
  return /^\d{1,2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value;
}

function toBlock(r: BlockRow): StoredScheduleBlock {
  return {
    id: r.id,
    weekday: r.weekday,
    startTime: trimSeconds(r.start_time),
    endTime: trimSeconds(r.end_time),
    mode: r.mode === 'online' ? 'online' : 'office',
    validFrom: r.valid_from,
    validTo: r.valid_to,
  };
}

/** 42P01 = undefined_table, 42703 = undefined_column. Migration not run yet. */
function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703';
}

/**
 * Every block for one membership, newest term first.
 *
 * The whole set, not just the current term — the edit screen shows what is in
 * force AND what has been entered for next term, and an admin looking at a past
 * month needs to see the schedule that was in force then.
 */
export async function listScheduleBlocks(
  companyId: string,
  userId: string
): Promise<StoredScheduleBlock[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_schedule_blocks')
    .select('id, user_id, weekday, start_time, end_time, mode, valid_from, valid_to')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .order('valid_from', { ascending: false })
    .order('weekday', { ascending: true })
    .order('start_time', { ascending: true });
  if (res.error) {
    if (isMissingSchema(res.error)) return [];
    throw new Error(res.error.message);
  }
  return ((res.data as BlockRow[] | null) ?? []).map(toBlock);
}

/**
 * The blocks in force for several people ON ONE DATE.
 *
 * This is what the attendance rule asks, once per uploaded sheet rather than
 * once per row. A date is judged against the schedule that was in force THEN,
 * which is the reason blocks carry validity dates at all: editing this term
 * must not silently re-score last term.
 */
export async function scheduleBlocksOnDate(
  companyId: string,
  userIds: string[],
  date: string
): Promise<Map<string, ScheduleBlock[]>> {
  const out = new Map<string, ScheduleBlock[]>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return out;

  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_schedule_blocks')
    .select('id, user_id, weekday, start_time, end_time, mode, valid_from, valid_to')
    .eq('company_id', companyId)
    .in('user_id', unique)
    .lte('valid_from', date)
    .or(`valid_to.is.null,valid_to.gte.${date}`);
  if (res.error) {
    // No table yet → nobody has blocks → the single start time still rules.
    if (isMissingSchema(res.error)) return out;
    throw new Error(res.error.message);
  }
  for (const row of (res.data as BlockRow[] | null) ?? []) {
    const list = out.get(row.user_id);
    const block = toBlock(row);
    if (list) list.push(block);
    else out.set(row.user_id, [block]);
  }
  return out;
}

/** One person's blocks in force on a date. */
export async function scheduleBlocksForUserOnDate(
  companyId: string,
  userId: string,
  date: string
): Promise<ScheduleBlock[]> {
  const map = await scheduleBlocksOnDate(companyId, [userId], date);
  return map.get(userId) ?? [];
}

export interface ScheduleBlockInput {
  weekday: number;
  startTime: string;
  endTime: string;
  mode: 'office' | 'online';
}

/**
 * REPLACE one term's blocks for one membership.
 *
 * A term is edited as a whole — the grid on the employee card is one schedule,
 * not a pile of rows — so this deletes that term's blocks and writes the new
 * set in their place. Scoped by (company, user, valid_from) so replacing this
 * term cannot touch next term's, which is the point of entering it in advance.
 *
 * Returns false when the table does not exist yet, so the caller can say the
 * schedule was not stored rather than claiming a save that did not happen.
 */
export async function replaceScheduleTerm(input: {
  companyId: string;
  userId: string;
  validFrom: string;
  validTo: string | null;
  blocks: ScheduleBlockInput[];
  createdBy: string;
}): Promise<boolean> {
  const supabase = getSupabaseAdmin();

  const del = await supabase
    .from('membership_schedule_blocks')
    .delete()
    .eq('company_id', input.companyId)
    .eq('user_id', input.userId)
    .eq('valid_from', input.validFrom);
  if (del.error) {
    if (isMissingSchema(del.error)) return false;
    throw new Error(del.error.message);
  }

  if (input.blocks.length === 0) return true;

  const ins = await supabase.from('membership_schedule_blocks').insert(
    input.blocks.map((b) => ({
      company_id: input.companyId,
      user_id: input.userId,
      weekday: b.weekday,
      start_time: b.startTime,
      end_time: b.endTime,
      mode: b.mode,
      valid_from: input.validFrom,
      valid_to: input.validTo,
      created_by: input.createdBy,
    }))
  );
  if (ins.error) {
    if (isMissingSchema(ins.error)) return false;
    throw new Error(ins.error.message);
  }
  return true;
}

/**
 * A lookup for "this person's blocks, in force on this date", built from ONE
 * query for a whole sheet.
 *
 * An attendance upload carries many people across many dates, and every row
 * has to be judged against the schedule in force on ITS date — not today's.
 * Asking the database per row would be thousands of round trips against a
 * database in another region; asking once for the range and filtering in memory
 * is the same answer.
 *
 * Returns a function so the caller cannot accidentally use one date's blocks
 * for another row, which is exactly the mistake the validity dates exist to
 * prevent.
 */
export async function scheduleBlockLookup(
  companyId: string,
  userIds: string[],
  fromDate: string,
  toDate: string
): Promise<(userId: string, date: string) => ScheduleBlock[]> {
  const empty: ScheduleBlock[] = [];
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return () => empty;

  const supabase = getSupabaseAdmin();
  // Overlap, not containment: a term that starts mid-sheet or ends mid-sheet
  // still governs the days it covers.
  const res = await supabase
    .from('membership_schedule_blocks')
    .select('id, user_id, weekday, start_time, end_time, mode, valid_from, valid_to')
    .eq('company_id', companyId)
    .in('user_id', unique)
    .lte('valid_from', toDate)
    .or(`valid_to.is.null,valid_to.gte.${fromDate}`);
  if (res.error) {
    if (isMissingSchema(res.error)) return () => empty;
    throw new Error(res.error.message);
  }

  const byUser = new Map<string, StoredScheduleBlock[]>();
  for (const row of (res.data as BlockRow[] | null) ?? []) {
    const block = toBlock(row);
    const list = byUser.get(row.user_id);
    if (list) list.push(block);
    else byUser.set(row.user_id, [block]);
  }

  return (userId: string, date: string): ScheduleBlock[] => {
    const all = byUser.get(userId);
    if (!all) return empty;
    return all.filter(
      (b) => b.validFrom <= date && (b.validTo === null || b.validTo >= date)
    );
  };
}
