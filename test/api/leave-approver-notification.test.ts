import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  COMPANY_B,
  EMPLOYEE_ID,
  MANAGER_ID,
  OTHER_EMPLOYEE_ID,
} from '../helpers/platformUser';

/**
 * Leave does NOT pause the task clock — a folder whose assignee is away keeps
 * ageing toward red. This notification is therefore the whole mechanism by
 * which the work actually gets picked up, so it has to reach the APPROVER (the
 * person who can reassign).
 *
 * ONE PER APPROVER, NOT PER TASK: testing on the deploy found a single booking
 * for someone holding 47 open tasks producing 47 bell items. The per-task detail
 * still exists on the folder's Details tab, in red.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/tasks', () => ({ listTasksForAssignee: vi.fn() }));
vi.mock('@/lib/platform/notifications', () => ({ insertNotifications: vi.fn() }));

const { listTasksForAssignee } = await import('@/lib/platform/tasks');
const { insertNotifications } = await import('@/lib/platform/notifications');
const { notifyAssigneeOnLeave } = await import('@/lib/platform/alerts');

const period = {
  userId: EMPLOYEE_ID,
  companyId: COMPANY_A,
  endDate: '2026-08-14',
};

/** The parts of TaskWithFile this notifier actually reads. */
function task(opts: {
  id: string;
  title: string;
  status: string;
  companyId?: string;
  approverId?: string | null;
}) {
  return {
    id: opts.id,
    title: opts.title,
    status: opts.status,
    assignee: {
      userId: EMPLOYEE_ID,
      username: 'jassim@albaker.qa',
      fullNameEn: 'Jassim AlBadi',
      fullNameAr: 'جاسم البادي',
    },
    approver:
      opts.approverId === null
        ? null
        : { userId: opts.approverId ?? MANAGER_ID, username: 'm@albaker.io' },
    file: { companyId: opts.companyId ?? COMPANY_A },
  };
}

function items() {
  return vi.mocked(insertNotifications).mock.calls[0][0];
}

describe('notifyAssigneeOnLeave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends ONE summary per approver, however many tasks they hold', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      task({ id: 't1', title: 'Draft the response', status: 'open' }),
      task({ id: 't2', title: 'File the appeal', status: 'open' }),
      task({ id: 't3', title: 'Chase the registry', status: 'open' }),
    ] as never);

    await notifyAssigneeOnLeave(period);

    expect(insertNotifications).toHaveBeenCalledTimes(1);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      userId: MANAGER_ID,
      companyId: COMPANY_A,
      taskId: null,
      type: 'assignee_on_leave',
    });
    expect(items()[0].messageEn).toContain('Jassim AlBadi');
    expect(items()[0].messageEn).toContain('2026-08-14');
    expect(items()[0].messageEn).toContain('3 of your open tasks need');
    expect(items()[0].messageAr).toContain('جاسم البادي');
    expect(items()[0].messageAr).toContain('3');
  });

  it('gives each approver their OWN count', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      task({ id: 't1', title: 'A', status: 'open' }),
      task({ id: 't2', title: 'B', status: 'open' }),
      task({ id: 't3', title: 'C', status: 'open', approverId: OTHER_EMPLOYEE_ID }),
    ] as never);

    await notifyAssigneeOnLeave(period);

    expect(items()).toHaveLength(2);
    const byUser = Object.fromEntries(items().map((i) => [i.userId, i.messageEn]));
    expect(byUser[MANAGER_ID]).toContain('2 of your open tasks need');
    expect(byUser[OTHER_EMPLOYEE_ID]).toContain('1 of your open task needs');
  });

  it('ignores tasks that are not open', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      task({ id: 't1', title: 'Done thing', status: 'approved' }),
    ] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it('ignores tasks belonging to another company', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      task({ id: 't1', title: 'Elsewhere', status: 'open', companyId: COMPANY_B }),
    ] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it('sends nothing when the person holds no tasks', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it('sends nothing when the open tasks have no approver', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      task({ id: 't1', title: 'Orphan', status: 'open', approverId: null }),
    ] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });
});
