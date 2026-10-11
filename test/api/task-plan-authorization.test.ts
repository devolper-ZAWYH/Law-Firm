import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  MANAGER_ID,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
} from '../helpers/platformUser';

/**
 * PATCH /api/tasks/:id/plan — putting a task on a day, taking it off one, or
 * recording how long it should take.
 *
 * WHY THIS ROUTE EXISTS SEPARATELY, AND WHAT THESE TESTS PIN
 *
 * Editing a task goes through PATCH /api/tasks/:id, which is gated behind
 * 'tasks.edit' and, for an employee holding that as an approval-required grant,
 * parks the edit in the approval queue. Planning deliberately does NOT do that:
 * a manager rearranging a week drags a dozen cards in a sitting, and routing
 * each through the queue would bury the requests that matter.
 *
 * The consequence is the thing worth a test. Because this route does not run
 * the approval gate, it must NOT honour the 'tasks.edit' grant either — that
 * grant was handed out WITH the gate attached, and accepting it here would
 * quietly give its holder an ungated write nobody agreed to. It is role-only:
 * manager or admin of the task's own company.
 *
 * That is an easy rule to "fix" later by making this route consistent with its
 * sibling. These tests are here to make that a deliberate decision rather than
 * an accident.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/files', () => ({ getFileById: vi.fn() }));
vi.mock('@/lib/platform/tasks', () => ({
  getTaskCore: vi.fn(),
  planTask: vi.fn(),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getFileById } = await import('@/lib/platform/files');
const { getTaskCore, planTask } = await import('@/lib/platform/tasks');
const { PATCH } = await import('@/app/api/tasks/[id]/plan/route');

const TASK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ctx = { params: { id: TASK_ID } };

/** A PATCH carrying an arbitrary plan body. */
function planRequest(body: unknown) {
  return { json: async () => body } as never;
}

describe('PATCH /api/tasks/:id/plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: MANAGER_ID } as never);
    vi.mocked(getTaskCore).mockResolvedValue({
      id: TASK_ID,
      fileId: FILE_ID,
      title: 'Draft the response',
      assigneeId: EMPLOYEE_ID,
      approverId: MANAGER_ID,
      createdBy: MANAGER_ID,
      status: 'open',
      assignedAt: '2026-08-01T09:00:00Z',
      accumulatedWorkingSeconds: 0,
      lastResumedAt: null,
    } as never);
    // The task's own file decides the company — never a value from the request.
    vi.mocked(getFileById).mockResolvedValue({
      id: FILE_ID,
      companyId: COMPANY_A,
    } as never);
    vi.mocked(planTask).mockResolvedValue({ ok: true } as never);
  });

  it('lets a manager of the company plan a task onto a day', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(planRequest({ scheduled_date: '2026-09-14' }), ctx);
    expect(res.status).toBe(200);
    expect(planTask).toHaveBeenCalledWith({
      taskId: TASK_ID,
      scheduledDate: '2026-09-14',
      estimatedHours: undefined,
    });
  });

  it('lets an admin plan a task', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await PATCH(planRequest({ estimated_hours: 2.5 }), ctx);
    expect(res.status).toBe(200);
    expect(planTask).toHaveBeenCalledWith({
      taskId: TASK_ID,
      scheduledDate: undefined,
      estimatedHours: 2.5,
    });
  });

  it('403s a plain employee — planning is role-only, not grantable', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await PATCH(planRequest({ scheduled_date: '2026-09-14' }), ctx);
    expect(res.status).toBe(403);
    expect(planTask).not.toHaveBeenCalled();
  });

  it('403s someone with no membership in the task’s company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    const res = await PATCH(planRequest({ scheduled_date: '2026-09-14' }), ctx);
    expect(res.status).toBe(403);
    expect(planTask).not.toHaveBeenCalled();
  });

  /**
   * null is a REAL value on both fields, not a synonym for "leave it alone".
   * A null scheduled_date is how a card is dragged back OUT of the calendar
   * into the unscheduled pile — if it were treated as absent, a task could go
   * onto a day and never come off it.
   */
  it('passes a null scheduled_date through as an unschedule', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(planRequest({ scheduled_date: null }), ctx);
    expect(res.status).toBe(200);
    expect(planTask).toHaveBeenCalledWith({
      taskId: TASK_ID,
      scheduledDate: null,
      estimatedHours: undefined,
    });
  });

  it('400s a body carrying neither field', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(planRequest({}), ctx);
    expect(res.status).toBe(400);
    expect(planTask).not.toHaveBeenCalled();
  });

  /**
   * 503, not 500: during the deploy window for migration #33 the columns do not
   * exist yet. Nothing is broken and a retry is the right answer, so it must
   * not be reported as a server fault.
   */
  it('503s while the scheduling columns are still missing', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(planTask).mockResolvedValue({
      ok: false,
      code: 'unavailable',
    } as never);
    const res = await PATCH(planRequest({ scheduled_date: '2026-09-14' }), ctx);
    expect(res.status).toBe(503);
  });

  /** A completed task's day has already happened; re-planning it would move
   *  finished work around the calendar after the fact. */
  it('409s a completed task', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(planTask).mockResolvedValue({ ok: false, code: 'locked' } as never);
    const res = await PATCH(planRequest({ scheduled_date: '2026-09-14' }), ctx);
    expect(res.status).toBe(409);
  });
});
