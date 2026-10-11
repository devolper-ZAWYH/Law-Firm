import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';

/**
 * Recurring follow-ups. The successor is created when the task is APPROVED —
 * not when it is marked done — because until a manager signs it off the work
 * is not finished, and issuing the next occurrence early would leave two open
 * copies of the same job.
 */

let stub: ReturnType<typeof makeSupabaseStub>;
let resolve: (q: QueryRecord) => { data?: unknown; error?: unknown };

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/notifications', () => ({
  insertNotifications: vi.fn(async () => undefined),
}));

const { approveTask } = await import('@/lib/platform/tasks');

const TASK_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** The task being approved, as getTaskCore and the recurrence read see it. */
function scenario(opts: { repeatEveryDays: number | null; dueAt: string | null }) {
  resolve = (q) => {
    if (q.table !== 'tasks') return { data: null };
    const isSelect = q.calls.some((c) => c.method === 'select');
    const isInsert = q.calls.some((c) => c.method === 'insert');
    if (isInsert) return { data: { id: 'new-task-id' } };
    if (isSelect) {
      return {
        data: {
          id: TASK_ID,
          file_id: 'file-1',
          title: 'Monthly follow-up',
          description: 'check in',
          assignee_id: 'emp-1',
          approver_id: 'mgr-1',
          created_by: 'mgr-1',
          status: 'awaiting_approval',
          assigned_at: '2026-01-01T00:00:00Z',
          accumulated_working_seconds: 0,
          last_resumed_at: null,
          due_at: opts.dueAt,
          repeat_every_days: opts.repeatEveryDays,
          excluded_from_color: false,
        },
      };
    }
    return { data: null };
  };
}

/** The insert that created a successor task, if any. */
function successorInsert(): Record<string, unknown> | null {
  const q = stub.queries.find(
    (x) => x.table === 'tasks' && x.calls.some((c) => c.method === 'insert')
  );
  return q ? (argOf(q, 'insert') as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeSupabaseStub((q) => resolve(q));
});

describe('approving a repeating task', () => {
  it('creates the next occurrence', async () => {
    scenario({ repeatEveryDays: 30, dueAt: '2026-03-01T00:00:00.000Z' });
    const res = await approveTask(TASK_ID, 'mgr-1');
    expect(res.ok).toBe(true);

    const next = successorInsert();
    expect(next).not.toBeNull();
    expect(next!.title).toBe('Monthly follow-up');
    expect(next!.status).toBe('open');
    // The interval is carried forward, so it keeps repeating.
    expect(next!.repeat_every_days).toBe(30);
  });

  it('chains the due date from the PREVIOUS due date, not from today', async () => {
    // Otherwise a monthly task approved three days late drifts three days
    // later every single cycle, and within a year it is in the wrong month.
    scenario({ repeatEveryDays: 30, dueAt: '2026-03-01T00:00:00.000Z' });
    await approveTask(TASK_ID, 'mgr-1');
    expect(successorInsert()!.due_at).toBe('2026-03-31T00:00:00.000Z');
  });

  it('creates NOTHING for a one-off task', async () => {
    scenario({ repeatEveryDays: null, dueAt: '2026-03-01T00:00:00.000Z' });
    const res = await approveTask(TASK_ID, 'mgr-1');
    expect(res.ok).toBe(true);
    expect(successorInsert()).toBeNull();
  });

  it('carries the colour-exclusion flag forward', async () => {
    resolve = (q) => {
      if (q.table !== 'tasks') return { data: null };
      if (q.calls.some((c) => c.method === 'insert')) return { data: { id: 'n' } };
      return {
        data: {
          id: TASK_ID,
          file_id: 'file-1',
          title: 'Reminder',
          description: null,
          assignee_id: 'emp-1',
          approver_id: 'mgr-1',
          created_by: 'mgr-1',
          status: 'awaiting_approval',
          assigned_at: '2026-01-01T00:00:00Z',
          accumulated_working_seconds: 0,
          last_resumed_at: null,
          due_at: '2026-06-01T00:00:00.000Z',
          repeat_every_days: 90,
          excluded_from_color: true,
        },
      };
    };
    await approveTask(TASK_ID, 'mgr-1');
    // A recurring reminder that was excluded must not start driving the
    // folder's colour the moment it renews.
    expect(successorInsert()!.excluded_from_color).toBe(true);
  });

  it('does not fail the approval when the follow-up cannot be created', async () => {
    // The approval is already recorded; a recurrence failure must not undo it.
    let first = true;
    resolve = (q) => {
      if (q.table !== 'tasks') return { data: null };
      if (q.calls.some((c) => c.method === 'insert')) {
        return { error: { code: '23503', message: 'fk violation' } };
      }
      if (first) {
        first = false;
        return {
          data: {
            id: TASK_ID, file_id: 'f', title: 'x', description: null,
            assignee_id: 'a', approver_id: 'b', created_by: 'c',
            status: 'awaiting_approval', assigned_at: '2026-01-01T00:00:00Z',
            accumulated_working_seconds: 0, last_resumed_at: null,
            due_at: null, repeat_every_days: 7, excluded_from_color: false,
          },
        };
      }
      return {
        data: {
          id: TASK_ID, file_id: 'f', title: 'x', description: null,
          assignee_id: 'a', approver_id: 'b', created_by: 'c',
          status: 'awaiting_approval', assigned_at: '2026-01-01T00:00:00Z',
          accumulated_working_seconds: 0, last_resumed_at: null,
          due_at: null, repeat_every_days: 7, excluded_from_color: false,
        },
      };
    };
    const res = await approveTask(TASK_ID, 'mgr-1');
    expect(res.ok).toBe(true);
  });
});
