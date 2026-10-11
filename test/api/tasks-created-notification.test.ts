import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  MANAGER_ID,
  jsonRequest,
  managerUser,
} from '../helpers/platformUser';

/**
 * POST /api/files/:id/tasks used to notify nobody at all when a task was
 * created — the approver only ever learned about a new task once it went
 * overdue or was marked done. This adds a 'task_created' in-app notification
 * to the named approver at creation time.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/files')>();
  return { ...actual, getFileById: vi.fn() };
});
vi.mock('@/lib/platform/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/access')>();
  return { ...actual, listFileMembers: vi.fn(), listCompanyManagers: vi.fn() };
});
vi.mock('@/lib/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/tasks')>();
  return { ...actual, listTasksForFile: vi.fn(), createTask: vi.fn() };
});
vi.mock('@/lib/platform/alerts', () => ({ notifyTaskCreated: vi.fn() }));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getFileById } = await import('@/lib/platform/files');
const { createTask } = await import('@/lib/platform/tasks');
const { notifyTaskCreated } = await import('@/lib/platform/alerts');
const { POST } = await import('@/app/api/files/[id]/tasks/route');

const FILE = { id: 'file-1', companyId: COMPANY_A };
const NEW_TASK = { id: 'task-99', fileId: 'file-1', title: 'Draft the claim' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ id: MANAGER_ID, username: 'm', role: 'user' });
  vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
  vi.mocked(getFileById).mockResolvedValue(FILE as never);
});

describe('POST /api/files/:id/tasks — task_created notification', () => {
  it('notifies the approver once the task is created', async () => {
    vi.mocked(createTask).mockResolvedValue({ ok: true, task: NEW_TASK } as never);
    const res = await POST(
      jsonRequest({
        title: 'Draft the claim',
        assignee_id: 'employee-1',
        approver_id: MANAGER_ID,
      }),
      { params: { id: 'file-1' } }
    );
    expect(res.status).toBe(201);
    expect(notifyTaskCreated).toHaveBeenCalledWith('task-99');
  });

  it('does not notify when creation fails validation', async () => {
    vi.mocked(createTask).mockResolvedValue({ ok: false, code: 'bad_approver' } as never);
    const res = await POST(
      jsonRequest({
        title: 'Draft the claim',
        assignee_id: 'employee-1',
        approver_id: 'not-a-manager',
      }),
      { params: { id: 'file-1' } }
    );
    expect(res.status).toBe(400);
    expect(notifyTaskCreated).not.toHaveBeenCalled();
  });

  it('still returns 201 even if the notification itself throws', async () => {
    vi.mocked(createTask).mockResolvedValue({ ok: true, task: NEW_TASK } as never);
    vi.mocked(notifyTaskCreated).mockRejectedValue(new Error('db down'));
    const res = await POST(
      jsonRequest({
        title: 'Draft the claim',
        assignee_id: 'employee-1',
        approver_id: MANAGER_ID,
      }),
      { params: { id: 'file-1' } }
    );
    expect(res.status).toBe(201);
  });
});
