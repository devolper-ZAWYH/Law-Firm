import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, MANAGER_ID, EMPLOYEE_ID } from '../helpers/platformUser';

/**
 * A folder's colour is DERIVED from how much working time its open tasks have
 * accrued — nothing stores "this task is red". So pushing a task back a step
 * has to be arithmetic on its own clock, and the number the manager types has
 * to mean exactly what it says: that many working days until the colour moves
 * again.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/leave', () => ({
  leaveEndFor: vi.fn(async () => null),
  todayIso: vi.fn(() => '2026-08-09'),
}));
vi.mock('@/lib/platform/access', () => ({
  isFileMember: vi.fn(async () => true),
  isCompanyManager: vi.fn(async () => true),
  fetchUsersByIds: vi.fn(async () => new Map()),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { pushBackTask } = await import('@/lib/platform/tasks');

const TASK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SECONDS_PER_DAY = 86400;
/** A working day (Sunday), frozen so the live clock contributes exactly zero. */
const FROZEN = '2026-08-09T09:00:00Z';

/**
 * A task holding exactly `accruedDays` of accrued time.
 *
 * last_resumed_at is pinned to the frozen "now", so the live portion of the
 * clock is zero and the accrued value is precisely what the colour engine
 * reads. Without that the test would measure real elapsed time since
 * assigned_at and drift with the calendar.
 */
function stub(opts: {
  accruedDays: number;
  status?: string;
  daysPerStep?: number;
}) {
  const s = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'tasks' && q.calls.some((c) => c.method === 'maybeSingle')) {
      return {
        data: {
          id: TASK_ID,
          file_id: FILE_ID,
          title: 'Draft the response',
          description: null,
          assignee_id: EMPLOYEE_ID,
          approver_id: MANAGER_ID,
          created_by: MANAGER_ID,
          status: opts.status ?? 'open',
          assigned_at: FROZEN,
          accumulated_working_seconds: opts.accruedDays * SECONDS_PER_DAY,
          last_resumed_at: FROZEN,
          last_alert_level: null,
          created_at: '2026-08-01T09:00:00Z',
        },
      };
    }
    if (q.table === 'files') {
      return { data: { company_id: COMPANY_A } };
    }
    if (q.table === 'companies') {
      return {
        data: {
          working_days: [0, 1, 2, 3, 4],
          days_per_color_step: opts.daysPerStep ?? 3,
        },
      };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    s.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
  return s;
}

/** The accumulated seconds written back, expressed in days. */
function writtenDays(s: ReturnType<typeof stub>): number {
  const upd = s.queries.find(
    (q) => q.table === 'tasks' && q.calls.some((c) => c.method === 'update')
  );
  const patch = argOf(upd!, 'update') as Record<string, number>;
  return patch.accumulated_working_seconds / SECONDS_PER_DAY;
}

const input = { taskId: TASK_ID, actorId: MANAGER_ID };

describe('pushBackTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN));
  });
  afterEach(() => vi.useRealTimers());

  it('leaves exactly the granted days below the next step', async () => {
    // 7 days accrued, 3 per step → step 2 (boundary at 6). Grant 2 days: the
    // task should sit at 4 days, i.e. 2 days below the step-2 boundary of 6.
    const s = stub({ accruedDays: 7 });
    const res = await pushBackTask({ ...input, days: 2 });
    expect(res).toEqual({ ok: true, grantedDays: 2 });
    expect(writtenDays(s)).toBe(4);
  });

  it('honours the granted days regardless of the company step size', async () => {
    // 11 days accrued, 5 per step → step 2 (boundary at 10). Grant 4 → 6 days.
    const s = stub({ accruedDays: 11, daysPerStep: 5 });
    await pushBackTask({ ...input, days: 4 });
    expect(writtenDays(s)).toBe(6);
  });

  it('drops further than one step when more days are granted than were climbed', async () => {
    // 7 days, 3 per step → step 2, boundary 6. Grant 6 → 0, the section's start.
    const s = stub({ accruedDays: 7 });
    await pushBackTask({ ...input, days: 6 });
    expect(writtenDays(s)).toBe(0);
  });

  it('never writes a negative clock', async () => {
    const s = stub({ accruedDays: 2 });
    await pushBackTask({ ...input, days: 99 });
    expect(writtenDays(s)).toBe(0);
  });

  it('restarts the clock from now', async () => {
    const s = stub({ accruedDays: 7 });
    await pushBackTask({ ...input, days: 2 });
    const upd = s.queries.find(
      (q) => q.table === 'tasks' && q.calls.some((c) => c.method === 'update')
    );
    const patch = argOf(upd!, 'update') as Record<string, string>;
    expect(typeof patch.last_resumed_at).toBe('string');
  });

  it('records a pushed_back event carrying the day count', async () => {
    const s = stub({ accruedDays: 7 });
    await pushBackTask({ ...input, days: 2 });
    const ev = s.queries.find(
      (q) => q.table === 'task_events' && q.calls.some((c) => c.method === 'insert')
    );
    expect(argOf(ev!, 'insert')).toMatchObject({
      task_id: TASK_ID,
      type: 'pushed_back',
      actor_id: MANAGER_ID,
      note: '2',
    });
  });

  it('ALSO accepts a submitted task', async () => {
    // Was refused as open-only. A submitted task is precisely the one that has
    // been waiting on somebody else, and it resumes from whatever it accrued —
    // so it comes back already red through no fault of the person who
    // submitted it on time. Granting days while it waits is the fix.
    stub({ accruedDays: 7, status: 'awaiting_approval' });
    expect(await pushBackTask({ ...input, days: 2 })).toEqual({
      ok: true,
      grantedDays: 2,
    });
  });

  it("leaves a submitted task's clock FROZEN", async () => {
    const s = stub({ accruedDays: 7, status: 'awaiting_approval' });
    await pushBackTask({ ...input, days: 2 });
    const upd = s.queries.find(
      (q) => q.table === 'tasks' && q.calls.some((c) => c.method === 'update')
    );
    // Restarting the timer here would quietly begin charging lateness for the
    // approver's own review time.
    expect(argOf(upd!, 'update')).not.toHaveProperty('last_resumed_at');
  });

  it('restarts the clock for an OPEN task', async () => {
    const s = stub({ accruedDays: 7, status: 'open' });
    await pushBackTask({ ...input, days: 2 });
    const upd = s.queries.find(
      (q) => q.table === 'tasks' && q.calls.some((c) => c.method === 'update')
    );
    expect(argOf(upd!, 'update')).toHaveProperty('last_resumed_at');
  });

  it('refuses a COMPLETED task', async () => {
    // Nothing to push back: an approved task has no running clock and no
    // colour to delay.
    stub({ accruedDays: 7, status: 'approved' });
    expect(await pushBackTask({ ...input, days: 2 })).toEqual({
      ok: false,
      code: 'bad_state',
    });
  });

  it('refuses a non-positive or non-numeric day count', async () => {
    stub({ accruedDays: 7 });
    expect(await pushBackTask({ ...input, days: 0 })).toEqual({
      ok: false,
      code: 'bad_input',
    });
    expect(await pushBackTask({ ...input, days: Number.NaN })).toEqual({
      ok: false,
      code: 'bad_input',
    });
  });
});
