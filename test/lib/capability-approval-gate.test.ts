import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

/**
 * The gate's decision logic — the part that decides whether an action happens
 * now, waits, or is refused. Everything downstream (routes, UI) trusts this
 * answer completely, so each branch is pinned explicitly.
 */

let stub: ReturnType<typeof makeSupabaseStub>;
let resolver: (q: QueryRecord) => { data?: unknown; error?: unknown };

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => stub.client,
}));
vi.mock('@/lib/platform/notifications', () => ({
  insertNotifications: vi.fn(async () => undefined),
}));

const { gateAction, listApprovalRequests, getApprovalManagerId } = await import(
  '@/lib/platform/approvals'
);
const { insertNotifications } = await import('@/lib/platform/notifications');

/** Grants the employee holds, and the company's assigned approver. */
function scenario(opts: {
  grants: Array<{ capability_key: string; requires_approval: boolean }>;
  approverId: string | null;
}) {
  resolver = (q) => {
    if (q.table === 'membership_capability_grants') return { data: opts.grants };
    if (q.table === 'companies') {
      return { data: { approval_manager_id: opts.approverId } };
    }
    if (q.table === 'capability_approval_requests') {
      return {
        data: {
          id: 'req-1',
          company_id: COMPANY_A,
          requester_id: EMPLOYEE_ID,
          capability_key: 'tasks.delete',
          action_type: 'task.delete',
          summary_en: 'Delete a task',
          summary_ar: 'حذف مهمة',
          status: 'pending',
          decided_by: null,
          decided_at: null,
          decision_note: null,
          created_at: '2026-08-18T10:00:00Z',
        },
      };
    }
    return { data: null };
  };
}

const baseInput = {
  userId: EMPLOYEE_ID,
  companyId: COMPANY_A,
  capabilityKey: 'tasks.delete',
  payload: { taskId: 'task-1' },
  summaryEn: 'Delete a task',
  summaryAr: 'حذف مهمة',
  isPrivileged: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeSupabaseStub((q) => resolver(q));
});

describe('gateAction', () => {
  it('never gates a manager/admin — their authority is the role, not a grant', async () => {
    scenario({ grants: [], approverId: MANAGER_ID });
    const res = await gateAction({ ...baseInput, isPrivileged: true });
    expect(res.kind).toBe('run');
    // It must not even look up grants for them.
    expect(stub.queries).toHaveLength(0);
  });

  it('runs an UNGATED grant immediately', async () => {
    scenario({
      grants: [{ capability_key: 'tasks.delete', requires_approval: false }],
      approverId: MANAGER_ID,
    });
    const res = await gateAction(baseInput);
    expect(res.kind).toBe('run');
  });

  it('HOLDS a gated grant and notifies the approver', async () => {
    scenario({
      grants: [{ capability_key: 'tasks.delete', requires_approval: true }],
      approverId: MANAGER_ID,
    });
    const res = await gateAction(baseInput);
    expect(res.kind).toBe('held');

    const inserted = stub.queries.find(
      (q) => q.table === 'capability_approval_requests'
    );
    expect(inserted).toBeDefined();
    // The notification goes to the ASSIGNED approver, nobody else.
    expect(vi.mocked(insertNotifications).mock.calls[0][0][0].userId).toBe(MANAGER_ID);
  });

  it('REFUSES when gated with no approving manager assigned', async () => {
    scenario({
      grants: [{ capability_key: 'tasks.delete', requires_approval: true }],
      approverId: null,
    });
    const res = await gateAction(baseInput);
    expect(res.kind).toBe('no_approver');
    // Refusing must not leave a request nobody can ever decide.
    expect(
      stub.queries.some((q) => q.table === 'capability_approval_requests')
    ).toBe(false);
  });

  it('runs a capability that has no executor, rather than pretending to gate it', async () => {
    scenario({
      grants: [{ capability_key: 'files.viewAll', requires_approval: true }],
      approverId: MANAGER_ID,
    });
    const res = await gateAction({ ...baseInput, capabilityKey: 'files.viewAll' });
    expect(res.kind).toBe('run');
  });

  it('lets an UNGATED covering grant win over a gated one', async () => {
    // 'files.move' held twice: once outright, once flagged. An explicit
    // "you may do this outright" must not be retracted by a stray flag.
    scenario({
      grants: [
        { capability_key: 'files.move', requires_approval: false },
        { capability_key: 'files.move.active', requires_approval: true },
      ],
      approverId: MANAGER_ID,
    });
    const res = await gateAction({ ...baseInput, capabilityKey: 'files.move' });
    expect(res.kind).toBe('run');
  });

  it('gates through a granted CHILD when that child is the only covering row', async () => {
    scenario({
      grants: [{ capability_key: 'files.move.active', requires_approval: true }],
      approverId: MANAGER_ID,
    });
    const res = await gateAction({ ...baseInput, capabilityKey: 'files.move' });
    expect(res.kind).toBe('held');
  });
});

describe('before migration #30 has been applied', () => {
  /**
   * Verified against the real database: PostgREST resolves table names against
   * a cached schema, so a table it has never seen returns PGRST205 — NOT the
   * Postgres SQLSTATE 42P01 that a missing-relation guard naturally reaches
   * for. Guarding only on 42P01 let the approvals inbox 500 for the whole
   * window between deploying the code and running the migration.
   */
  it('treats PostgREST’s PGRST205 as "not migrated yet", not as an error', async () => {
    resolver = () => ({
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.capability_approval_requests'",
      },
    });
    await expect(listApprovalRequests(COMPANY_A)).resolves.toEqual([]);
  });

  it('treats a missing approval_manager_id column as "nobody assigned"', async () => {
    resolver = () => ({
      error: { code: '42703', message: 'column companies.approval_manager_id does not exist' },
    });
    await expect(getApprovalManagerId(COMPANY_A)).resolves.toBeNull();
  });

  it('still surfaces a REAL database error rather than swallowing it', async () => {
    resolver = () => ({ error: { code: '08006', message: 'connection failure' } });
    await expect(listApprovalRequests(COMPANY_A)).rejects.toThrow('connection failure');
  });
});
