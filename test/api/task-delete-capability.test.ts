import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
  unusedRequest,
} from '../helpers/platformUser';
import { isCapabilityKey, isApprovableCapability } from '@/lib/platform/capabilities';

/**
 * Deleting a task used to be admin-only and absent from the capability tree,
 * because it destroys the task's history. It is now GRANTABLE — with that
 * weight carried by the approval gate instead of by withholding the permission
 * outright.
 *
 * These tests pin the three outcomes the route must distinguish, since they are
 * easy to collapse into one another by accident:
 *   • DELETED    — role, or an ungated grant.
 *   • HELD (202) — a gated grant. NOTHING is deleted.
 *   • REFUSED    — no grant at all (403), or gated with no approver (409).
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => true),
}));
vi.mock('@/lib/platform/approvals', () => ({ gateAction: vi.fn() }));
vi.mock('@/lib/platform/files', () => ({ getFileById: vi.fn() }));
vi.mock('@/lib/platform/tasks', () => ({
  getTaskCore: vi.fn(),
  deleteTask: vi.fn(),
  editTask: vi.fn(),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { gateAction } = await import('@/lib/platform/approvals');
const { getFileById } = await import('@/lib/platform/files');
const { getTaskCore, deleteTask } = await import('@/lib/platform/tasks');
const route = await import('@/app/api/tasks/[id]/route');

const TASK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ctx = { params: { id: TASK_ID } };

describe('deleting a task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(gateAction).mockResolvedValue({ kind: 'run' } as never);
    vi.mocked(getTaskCore).mockResolvedValue({
      id: TASK_ID,
      fileId: FILE_ID,
      title: 'Draft the response',
      assigneeId: EMPLOYEE_ID,
      approverId: EMPLOYEE_ID,
      createdBy: EMPLOYEE_ID,
      status: 'open',
      assignedAt: '2026-08-01T09:00:00Z',
      accumulatedWorkingSeconds: 0,
      lastResumedAt: null,
    } as never);
    vi.mocked(getFileById).mockResolvedValue({
      id: FILE_ID,
      companyId: COMPANY_A,
    } as never);
  });

  it('is a grantable capability that can be approval-gated', () => {
    expect(isCapabilityKey('tasks.delete')).toBe(true);
    expect(isApprovableCapability('tasks.delete')).toBe(true);
  });

  it('lets an admin delete outright, without consulting the gate', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(200);
    expect(deleteTask).toHaveBeenCalledWith(TASK_ID);
    // A privileged caller must still be reported as privileged, or the gate
    // would look up a grant they do not have.
    expect(vi.mocked(gateAction).mock.calls[0][0].isPrivileged).toBe(true);
  });

  it('lets a manager of the company delete', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(200);
    expect(deleteTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('lets an employee granted tasks.delete (ungated) delete', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(200);
    expect(deleteTask).toHaveBeenCalledWith(TASK_ID);
    expect(vi.mocked(gateAction).mock.calls[0][0].isPrivileged).toBe(false);
  });

  it('refuses an employee with no grant', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(403);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('refuses someone from another company outright', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(403);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('HOLDS a gated grant at 202 and deletes NOTHING', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-1' },
    } as never);

    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(202);
    // The whole point of the feature: the action has NOT taken place.
    expect(deleteTask).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe('pending_approval');
    expect(body.requestId).toBe('req-1');
  });

  it('parks the task id, so approving replays exactly this deletion', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-1' },
    } as never);
    await route.DELETE(unusedRequest, ctx);
    expect(vi.mocked(gateAction).mock.calls[0][0].payload).toEqual({ taskId: TASK_ID });
  });

  it('refuses (409) when gated but no approving manager is assigned', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(gateAction).mockResolvedValue({ kind: 'no_approver' } as never);

    const res = await route.DELETE(unusedRequest, ctx);
    expect(res.status).toBe(409);
    expect(deleteTask).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe('no_approver');
  });
});
