import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';

/**
 * End-to-end visibility check for the manager-as-approver workflow, exercised
 * against the REAL data-layer queries (not mocked away) — the actual thing
 * the user asked to have confirmed: a task created by an employee (with
 * 'tasks.create' granted), naming a manager as approver, must:
 *   1. show up for the manager under "Tasks you'll approve" (listOpenForApprover)
 *      the moment it's created (status 'open') — NOT under "awaiting my approval",
 *   2. move OUT of "Tasks you'll approve" and INTO "awaiting my approval"
 *      (listAwaitingApprovalForApprover) once the assignee marks it done
 *      (status 'awaiting_approval'),
 *   3. never appear in both lists at once, at either stage.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { listOpenForApprover, listAwaitingApprovalForApprover } = await import(
  '@/lib/platform/tasks'
);

const MANAGER_ID = 'manager-1';
const EMPLOYEE_ASSIGNEE_ID = 'assignee-1';
const EMPLOYEE_CREATOR_ID = 'employee-creator-1';
const FILE_ID = 'file-1';
const COMPANY_ID = 'company-1';
const TASK_ID = 'task-1';

/** The one task row this test tracks; `status` flips mid-test. */
function taskRow(status: 'open' | 'awaiting_approval') {
  return {
    id: TASK_ID,
    file_id: FILE_ID,
    title: 'Draft the claim',
    description: null,
    assignee_id: EMPLOYEE_ASSIGNEE_ID,
    approver_id: MANAGER_ID,
    created_by: EMPLOYEE_CREATOR_ID,
    status,
    assigned_at: '2026-01-01T00:00:00Z',
    accumulated_working_seconds: 0,
    last_resumed_at: status === 'open' ? '2026-01-01T00:00:00Z' : null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

/** Wires a stub whose 'tasks' select answers with `rows`, filtered like the
 * real handlers do (approver_id / status / assignee_id eq/neq). */
function stubFor(rows: ReturnType<typeof taskRow>[]) {
  const stub = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'tasks') {
      let result = rows;
      for (const call of q.calls) {
        if (call.method === 'eq' && call.args[0] === 'approver_id') {
          result = result.filter((r) => r.approver_id === call.args[1]);
        }
        if (call.method === 'eq' && call.args[0] === 'status') {
          result = result.filter((r) => r.status === call.args[1]);
        }
        if (call.method === 'neq' && call.args[0] === 'assignee_id') {
          result = result.filter((r) => r.assignee_id !== call.args[1]);
        }
      }
      return { data: result };
    }
    if (q.table === 'task_events') {
      return { data: [] };
    }
    if (q.table === 'files') {
      return {
        data: [
          {
            id: FILE_ID,
            company_id: COMPANY_ID,
            client: 'Ali',
            opponent: 'Sara',
            drive_link: null,
            section: 'active',
          },
        ],
      };
    }
    if (q.table === 'companies') {
      return {
        data: [
          {
            id: COMPANY_ID,
            name_en: 'Firm',
            name_ar: 'مكتب',
            working_days: [0, 1, 2, 3, 4],
            days_per_color_step: 3,
          },
        ],
      };
    }
    if (q.table === 'app_users') {
      return {
        data: [
          { id: MANAGER_ID, username: 'manager', full_name_en: 'Manager', full_name_ar: 'مدير' },
          {
            id: EMPLOYEE_ASSIGNEE_ID,
            username: 'assignee',
            full_name_en: 'Assignee',
            full_name_ar: 'موظف',
          },
          {
            id: EMPLOYEE_CREATOR_ID,
            username: 'creator',
            full_name_en: 'Creator',
            full_name_ar: 'منشئ',
          },
        ],
      };
    }
    return { data: null };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('manager-as-approver visibility across the task lifecycle', () => {
  it('an OPEN task shows under "Tasks you\'ll approve", not "awaiting my approval"', async () => {
    stubFor([taskRow('open')]);

    const pending = await listOpenForApprover(MANAGER_ID);
    const awaiting = await listAwaitingApprovalForApprover(MANAGER_ID);

    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(TASK_ID);
    expect(pending[0].assignee?.userId).toBe(EMPLOYEE_ASSIGNEE_ID);
    expect(pending[0].approver?.userId).toBe(MANAGER_ID);
    expect(awaiting).toHaveLength(0);
  });

  it('once marked done, it moves to "awaiting my approval" and drops out of "Tasks you\'ll approve"', async () => {
    stubFor([taskRow('awaiting_approval')]);

    const pending = await listOpenForApprover(MANAGER_ID);
    const awaiting = await listAwaitingApprovalForApprover(MANAGER_ID);

    expect(pending).toHaveLength(0);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].id).toBe(TASK_ID);
  });

  it('a self-assigned task (assignee === approver) is excluded from "Tasks you\'ll approve"', async () => {
    const selfTask = { ...taskRow('open'), assignee_id: MANAGER_ID };
    stubFor([selfTask]);

    const pending = await listOpenForApprover(MANAGER_ID);
    expect(pending).toHaveLength(0);
  });
});
