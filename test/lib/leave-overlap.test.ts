import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/workingHours', () => ({
  getWorkingSchedulesForUsers: vi.fn(async () => new Map()),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { createLeavePeriod } = await import('@/lib/platform/leave');

/** `existing` is what the overlap probe finds. */
function stubWith(existing: unknown[]) {
  const stub = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'leave_periods') {
      // The overlap probe selects without inserting; the create inserts.
      if (q.calls.some((c) => c.method === 'insert')) {
        return {
          data: {
            id: 'leave-1',
            user_id: EMPLOYEE_ID,
            company_id: COMPANY_A,
            start_date: '2026-08-10',
            end_date: '2026-08-14',
            note: null,
            created_by: MANAGER_ID,
            created_at: '2026-08-08T00:00:00Z',
          },
        };
      }
      return { data: existing };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    stub.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
  return stub;
}

const base = {
  companyId: COMPANY_A,
  userId: EMPLOYEE_ID,
  startDate: '2026-08-10',
  endDate: '2026-08-14',
  note: null,
  createdBy: MANAGER_ID,
};

describe('createLeavePeriod', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a period overlapping an existing one for the same person', async () => {
    stubWith([{ id: 'existing', start_date: '2026-08-12', end_date: '2026-08-20' }]);
    const res = await createLeavePeriod(base);
    expect(res).toEqual({ ok: false, code: 'overlap' });
  });

  it('creates when nothing overlaps', async () => {
    stubWith([]);
    const res = await createLeavePeriod(base);
    expect(res.ok).toBe(true);
  });

  it('rejects an end date before the start date', async () => {
    stubWith([]);
    const res = await createLeavePeriod({ ...base, endDate: '2026-08-09' });
    expect(res).toEqual({ ok: false, code: 'bad_input' });
  });

  it('rejects a malformed date', async () => {
    stubWith([]);
    const res = await createLeavePeriod({ ...base, startDate: '10-08-2026' });
    expect(res).toEqual({ ok: false, code: 'bad_input' });
  });
});
