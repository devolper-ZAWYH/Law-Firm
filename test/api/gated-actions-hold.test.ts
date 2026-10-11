import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, employeeUser } from '../helpers/platformUser';

/**
 * The property that matters for EVERY gated permission, checked at the route:
 * when the gate says "held", the action does NOT happen and the caller is told
 * so with 202 — and when no approving manager is assigned, it is refused with
 * 409 rather than let through.
 *
 * One route per action family; the gate itself is unit-tested separately.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/approvals', () => ({ gateAction: vi.fn() }));
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => true),
}));
vi.mock('@/lib/platform/files', () => ({
  getFileById: vi.fn(async () => ({
    id: 'file-1',
    companyId: COMPANY_A,
    clientEn: 'Acme',
    clientAr: 'أكمي',
  })),
  isFileAssignedToUser: vi.fn(async () => true),
}));
vi.mock('@/lib/platform/tasks', () => ({
  getTaskCore: vi.fn(async () => ({
    id: 'task-1',
    fileId: 'file-1',
    title: 'Draft it',
    assigneeId: EMPLOYEE_ID,
    approverId: EMPLOYEE_ID,
    createdBy: EMPLOYEE_ID,
    status: 'open',
    assignedAt: '2026-01-01T00:00:00Z',
    accumulatedWorkingSeconds: 0,
    lastResumedAt: null,
  })),
  editTask: vi.fn(async () => ({ ok: true })),
  deleteTask: vi.fn(),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { gateAction } = await import('@/lib/platform/approvals');
const { editTask } = await import('@/lib/platform/tasks');
const tasksRoute = await import('@/app/api/tasks/[id]/route');

function jsonReq(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Parameters<typeof tasksRoute.PATCH>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
  vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
});

describe('editing a task through a gated grant', () => {
  it('HOLDS at 202 and edits nothing', async () => {
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-edit' },
    } as never);

    const res = await tasksRoute.PATCH(jsonReq({ title: 'New title' }), {
      params: { id: 'task-1' },
    });
    expect(res.status).toBe(202);
    expect(editTask).not.toHaveBeenCalled();
    expect((await res.json()).code).toBe('pending_approval');
  });

  it('parks only the fields that were actually sent', async () => {
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-edit' },
    } as never);
    await tasksRoute.PATCH(jsonReq({ title: 'New title' }), { params: { id: 'task-1' } });

    const payload = vi.mocked(gateAction).mock.calls[0][0].payload;
    expect(payload).toHaveProperty('title', 'New title');
    // An absent field must stay absent, so replaying still means "leave as is"
    // rather than "blank it".
    expect(payload).not.toHaveProperty('assigneeId');
    expect(payload).not.toHaveProperty('approverId');
    expect(payload).not.toHaveProperty('description');
  });

  it('REFUSES at 409 when gated with no approving manager', async () => {
    vi.mocked(gateAction).mockResolvedValue({ kind: 'no_approver' } as never);
    const res = await tasksRoute.PATCH(jsonReq({ title: 'New title' }), {
      params: { id: 'task-1' },
    });
    expect(res.status).toBe(409);
    expect(editTask).not.toHaveBeenCalled();
    expect((await res.json()).code).toBe('no_approver');
  });

  it('edits normally when the grant is ungated', async () => {
    vi.mocked(gateAction).mockResolvedValue({ kind: 'run' } as never);
    const res = await tasksRoute.PATCH(jsonReq({ title: 'New title' }), {
      params: { id: 'task-1' },
    });
    expect(res.status).toBe(200);
    expect(editTask).toHaveBeenCalled();
  });
});
