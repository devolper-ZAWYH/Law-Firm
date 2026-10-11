import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID, OTHER_EMPLOYEE_ID } from '../helpers/platformUser';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';

/**
 * "Tasks cannot be assigned to someone on leave" is enforced HERE as well as in
 * the picker, so a hand-posted request cannot get round a disabled <option>.
 * There is deliberately no manager override.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/leave', () => ({
  leaveEndFor: vi.fn(),
  todayIso: vi.fn(() => '2026-08-11'),
}));
vi.mock('@/lib/platform/access', () => ({
  isFileMember: vi.fn(),
  isCompanyManager: vi.fn(),
  fetchUsersByIds: vi.fn(async () => new Map()),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { leaveEndFor } = await import('@/lib/platform/leave');
const { isFileMember, isCompanyManager } = await import('@/lib/platform/access');
const { createTask, reassignTask, editTask } = await import('@/lib/platform/tasks');

/** An OPEN task currently held by someone else, so editTask sees a real change. */
function stubOpenTask() {
  const s = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'tasks' && q.calls.some((c) => c.method === 'maybeSingle')) {
      return {
        data: {
          id: TASK_ID,
          file_id: FILE_ID,
          title: 'Draft the response',
          description: null,
          assignee_id: OTHER_EMPLOYEE_ID,
          approver_id: MANAGER_ID,
          created_by: MANAGER_ID,
          status: 'open',
          assigned_at: '2026-08-01T09:00:00Z',
          accumulated_working_seconds: 0,
          last_resumed_at: '2026-08-01T09:00:00Z',
          last_alert_level: null,
          created_at: '2026-08-01T09:00:00Z',
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

const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TASK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const createInput = {
  fileId: FILE_ID,
  companyId: COMPANY_A,
  title: 'Draft the response',
  description: null,
  assigneeId: EMPLOYEE_ID,
  approverId: MANAGER_ID,
  createdBy: MANAGER_ID,
};

describe('createTask — assignee on leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFileMember).mockResolvedValue(true);
    vi.mocked(isCompanyManager).mockResolvedValue(true);
  });

  it('refuses an assignee who is on leave today', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    const res = await createTask(createInput);
    expect(res).toEqual({
      ok: false,
      code: 'assignee_on_leave',
      onLeaveUntil: '2026-08-14',
    });
  });

  it('checks leave for the ASSIGNEE, on today’s date, in the file’s company', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    await createTask(createInput);
    expect(leaveEndFor).toHaveBeenCalledWith(EMPLOYEE_ID, COMPANY_A, '2026-08-11');
  });

  it('lets a person who is not on leave through the guard', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue(null);
    // Not on the file and not a manager → the PRE-EXISTING rejection, which can
    // only be reached once the leave guard has let the call past.
    vi.mocked(isFileMember).mockResolvedValue(false);
    vi.mocked(isCompanyManager).mockResolvedValue(false);
    const res = await createTask(createInput);
    expect(res).toEqual({ ok: false, code: 'bad_assignee' });
  });
});

describe('reassignTask — assignee on leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFileMember).mockResolvedValue(true);
    vi.mocked(isCompanyManager).mockResolvedValue(true);
  });

  it('refuses to hand a task to someone on leave', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    const res = await reassignTask({
      taskId: TASK_ID,
      fileId: FILE_ID,
      companyId: COMPANY_A,
      newAssigneeId: EMPLOYEE_ID,
      actorId: MANAGER_ID,
    });
    expect(res).toEqual({
      ok: false,
      code: 'assignee_on_leave',
      onLeaveUntil: '2026-08-14',
    });
  });
});

describe('editTask — assignee on leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFileMember).mockResolvedValue(true);
    vi.mocked(isCompanyManager).mockResolvedValue(true);
  });

  it('refuses an edit that moves the task to someone on leave', async () => {
    stubOpenTask();
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    const res = await editTask({
      taskId: TASK_ID,
      fileId: FILE_ID,
      companyId: COMPANY_A,
      actorId: MANAGER_ID,
      assigneeId: EMPLOYEE_ID,
    });
    expect(res).toEqual({
      ok: false,
      code: 'assignee_on_leave',
      onLeaveUntil: '2026-08-14',
    });
  });
});
