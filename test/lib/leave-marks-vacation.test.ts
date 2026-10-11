import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

/**
 * Booking leave has to reach into the attendance sheet, because the two records
 * would otherwise disagree: a booked holiday with no attendance row is read as
 * an ABSENCE on upload, which costs the person a full working day of lateness
 * (ABSENT_LATE_MINUTES = 480).
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/workingHours', () => ({
  getWorkingSchedulesForUsers: vi.fn(),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getWorkingSchedulesForUsers } = await import('@/lib/platform/workingHours');
const { createLeavePeriod } = await import('@/lib/platform/leave');

/** `existingDays` are dates that already carry an attendance record. */
function stub(existingDays: string[] = []) {
  const s = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'leave_periods' && q.calls.some((c) => c.method === 'insert')) {
      return {
        data: {
          id: 'leave-1',
          user_id: EMPLOYEE_ID,
          company_id: COMPANY_A,
          start_date: '2026-08-10',
          end_date: '2026-08-12',
          note: null,
          created_by: MANAGER_ID,
          created_at: '2026-08-08T00:00:00Z',
        },
      };
    }
    if (q.table === 'attendance_records' && q.calls.some((c) => c.method === 'select')) {
      return { data: existingDays.map((d) => ({ date: d })) };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    s.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
  return s;
}

function upsertRows(s: ReturnType<typeof stub>) {
  const q = s.queries.find(
    (r) => r.table === 'attendance_records' && r.calls.some((c) => c.method === 'upsert')
  );
  if (!q) return null;
  return argOf(q, 'upsert') as Array<Record<string, unknown>>;
}

const input = {
  companyId: COMPANY_A,
  userId: EMPLOYEE_ID,
  startDate: '2026-08-10', // Monday
  endDate: '2026-08-12', // Wednesday
  note: null,
  createdBy: MANAGER_ID,
};

describe('createLeavePeriod → attendance vacation days', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Nothing configured → works every day.
    vi.mocked(getWorkingSchedulesForUsers).mockResolvedValue(
      new Map([[EMPLOYEE_ID, { workingDays: null, startTime: null }]])
    );
  });

  it('writes one vacation row per day of the range', async () => {
    const s = stub();
    await createLeavePeriod(input);
    const rows = upsertRows(s);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.date)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
    ]);
    for (const r of rows!) {
      expect(r.day_status).toBe('vacation');
      expect(r.late_minutes).toBe(0);
      expect(r.user_id).toBe(EMPLOYEE_ID);
      expect(r.company_id).toBe(COMPANY_A);
    }
  });

  it('skips a day that already has an attendance record', async () => {
    const s = stub(['2026-08-11']);
    await createLeavePeriod(input);
    expect(upsertRows(s)!.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-12']);
  });

  it('skips days the person does not work', async () => {
    // Sunday(0) to Thursday(4). 2026-08-13 is a Thursday, 14th Friday, 15th Saturday.
    vi.mocked(getWorkingSchedulesForUsers).mockResolvedValue(
      new Map([[EMPLOYEE_ID, { workingDays: [0, 1, 2, 3, 4], startTime: '09:00' }]])
    );
    const s = stub();
    await createLeavePeriod({ ...input, startDate: '2026-08-13', endDate: '2026-08-15' });
    expect(upsertRows(s)!.map((r) => r.date)).toEqual(['2026-08-13']);
  });

  it('still creates the period when no day needs a vacation row', async () => {
    const s = stub(['2026-08-10', '2026-08-11', '2026-08-12']);
    const res = await createLeavePeriod(input);
    expect(res.ok).toBe(true);
    expect(upsertRows(s)).toBeNull();
  });
});
