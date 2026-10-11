import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGER_ID } from '../helpers/platformUser';

/**
 * GET /api/tasks/pending-approval — an approver's "still open, not marked
 * done yet" queue. Added so a manager sees a task the moment it's created
 * (by anyone, including a capability-granted employee) rather than only
 * once it reaches 'awaiting_approval'.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/tasks')>();
  return { ...actual, listOpenForApprover: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { listOpenForApprover } = await import('@/lib/platform/tasks');
const { GET } = await import('@/app/api/tasks/pending-approval/route');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/tasks/pending-approval', () => {
  it('401s when unauthenticated', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the caller's open tasks where they're the named approver", async () => {
    vi.mocked(getSession).mockResolvedValue({ id: MANAGER_ID, username: 'm', role: 'user' });
    vi.mocked(getPlatformUser).mockResolvedValue({ userId: MANAGER_ID } as never);
    vi.mocked(listOpenForApprover).mockResolvedValue([{ id: 'task-1' }] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(listOpenForApprover).toHaveBeenCalledWith(MANAGER_ID);
    const data = (await res.json()) as { ok: boolean; tasks: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.tasks).toHaveLength(1);
  });
});
