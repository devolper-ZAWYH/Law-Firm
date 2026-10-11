import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  MANAGER_ID,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
} from '../helpers/platformUser';

/**
 * Who may decide a held request.
 *
 * Being a manager is NOT enough — only the company's ADMIN-ASSIGNED approving
 * manager (or a global admin). That is the whole point of the assignment: the
 * person who hands out a gated permission must not also be able to wave through
 * its use.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/approvals', () => ({
  getApprovalRequest: vi.fn(),
  getApprovalManagerId: vi.fn(),
  decideApprovalRequest: vi.fn(async () => ({ ok: true, status: 'approved' })),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getApprovalRequest, getApprovalManagerId, decideApprovalRequest } =
  await import('@/lib/platform/approvals');
const { POST } = await import('@/app/api/approvals/[id]/decide/route');

const ctx = { params: { id: 'req-1' } };

function req(body: Record<string, unknown> = { decision: 'approved' }) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ sub: MANAGER_ID } as never);
  vi.mocked(getApprovalRequest).mockResolvedValue({
    id: 'req-1',
    companyId: COMPANY_A,
    status: 'pending',
  } as never);
  // MANAGER_ID is the assigned approver in this company.
  vi.mocked(getApprovalManagerId).mockResolvedValue(MANAGER_ID);
});

describe('POST /api/approvals/:id/decide', () => {
  it('lets the ASSIGNED approving manager decide', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(decideApprovalRequest).toHaveBeenCalled();
  });

  it('lets a global admin decide', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
  });

  it('refuses a manager who is NOT the assigned approver', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(getApprovalManagerId).mockResolvedValue('someone-else');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('refuses a plain employee', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('refuses when no approver is assigned at all', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(getApprovalManagerId).mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('hides another company’s request behind 404, not 403', async () => {
    // An outsider must not even learn that the request exists.
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('rejects a decision that is neither approved nor rejected', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await POST(req({ decision: 'maybe' }), ctx);
    expect(res.status).toBe(400);
    expect(decideApprovalRequest).not.toHaveBeenCalled();
  });
});
