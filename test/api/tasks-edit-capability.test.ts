import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, employeeUser, jsonRequest } from '../helpers/platformUser';

/**
 * PATCH /api/tasks/:id used to hardcode "admin or manager of the task's
 * company" with no capability-tree fallback at all, so granting an employee
 * 'tasks.edit' via the Permissions tab had zero effect — they still hit 403.
 * This is the bug the user originally reported.
 *
 * DELETE is covered by test/api/task-delete-capability.test.ts, which owns the
 * full gate (role / ungated grant / held / refused) now that deletion is
 * grantable and approval-gateable.
 */

// The route now consults the approval gate. Ungated here — these tests are
// about WHO may perform the action, not about holding it for an approver.
vi.mock('@/lib/platform/approvals', () => ({
  gateAction: vi.fn(async () => ({ kind: 'run' })),
}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/files')>();
  return { ...actual, getFileById: vi.fn() };
});
vi.mock('@/lib/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/tasks')>();
  return { ...actual, getTaskCore: vi.fn(), editTask: vi.fn(), deleteTask: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/capabilityGrants')>();
  return { ...actual, hasCapabilityGrant: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getFileById } = await import('@/lib/platform/files');
const { getTaskCore, editTask } = await import('@/lib/platform/tasks');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { PATCH } = await import('@/app/api/tasks/[id]/route');

const TASK = {
  id: 'task-1',
  fileId: 'file-1',
  title: 'Draft the claim',
  assigneeId: EMPLOYEE_ID,
  approverId: 'someone',
  createdBy: 'someone',
  status: 'open',
  assignedAt: '2026-01-01T00:00:00Z',
  accumulatedWorkingSeconds: 0,
  lastResumedAt: null,
};
const FILE = { id: 'file-1', companyId: COMPANY_A };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ id: EMPLOYEE_ID, username: 'e', role: 'user' });
  vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
  vi.mocked(getTaskCore).mockResolvedValue(TASK as never);
  vi.mocked(getFileById).mockResolvedValue(FILE as never);
});

describe('PATCH /api/tasks/:id — tasks.edit', () => {
  it('403s a plain employee with no grant', async () => {
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await PATCH(jsonRequest({ title: 'New title' }), {
      params: { id: 'task-1' },
    });
    expect(res.status).toBe(403);
    expect(hasCapabilityGrant).toHaveBeenCalledWith(EMPLOYEE_ID, COMPANY_A, 'tasks.edit');
    expect(editTask).not.toHaveBeenCalled();
  });

  it('allows an employee explicitly granted tasks.edit', async () => {
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(editTask).mockResolvedValue({ ok: true } as never);
    const res = await PATCH(jsonRequest({ title: 'New title' }), {
      params: { id: 'task-1' },
    });
    expect(res.status).toBe(200);
    expect(editTask).toHaveBeenCalled();
  });
});
