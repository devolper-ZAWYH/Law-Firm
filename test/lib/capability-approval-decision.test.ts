import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

/**
 * Deciding a held request. The property that matters most: the parked action
 * runs ONLY on an approval that is still legitimate at the moment it is
 * decided — never on a rejection, never twice, and never on a grant that was
 * revoked while the request sat waiting.
 */

let stub: ReturnType<typeof makeSupabaseStub>;
let resolver: (q: QueryRecord) => { data?: unknown; error?: unknown };

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/notifications', () => ({
  insertNotifications: vi.fn(async () => undefined),
}));
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => true),
  requiresApprovalFor: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/approvalExecutors', () => ({
  isApprovalActionType: (v: unknown) => v === 'task.delete',
  runApprovedAction: vi.fn(async () => ({ ok: true })),
}));

const { decideApprovalRequest } = await import('@/lib/platform/approvals');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { runApprovedAction } = await import('@/lib/platform/approvalExecutors');
const { insertNotifications } = await import('@/lib/platform/notifications');

const REQUEST_ID = 'req-1';

function pendingRequest(status = 'pending') {
  return {
    id: REQUEST_ID,
    company_id: COMPANY_A,
    requester_id: EMPLOYEE_ID,
    capability_key: 'tasks.delete',
    action_type: 'task.delete',
    payload: { taskId: 'task-1' },
    summary_en: 'Delete a task',
    summary_ar: 'حذف مهمة',
    status,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: '2026-08-18T10:00:00Z',
  };
}

/** `claimWins` = the conditional pending→decided update matched a row. */
function scenario(opts: { status?: string; claimWins?: boolean } = {}) {
  let seenSelect = false;
  resolver = (q) => {
    if (q.table !== 'capability_approval_requests') return { data: null };
    const isUpdate = q.calls.some((c) => c.method === 'update');
    if (isUpdate) {
      return { data: opts.claimWins === false ? null : { id: REQUEST_ID } };
    }
    seenSelect = true;
    return { data: pendingRequest(opts.status ?? 'pending') };
  };
  void seenSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeSupabaseStub((q) => resolver(q));
  vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
  vi.mocked(runApprovedAction).mockResolvedValue({ ok: true } as never);
});

describe('decideApprovalRequest', () => {
  it('runs the parked action on approval, with the REQUESTER as the actor', async () => {
    scenario();
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res).toEqual({ ok: true, status: 'approved' });
    expect(runApprovedAction).toHaveBeenCalledWith(
      'task.delete',
      { taskId: 'task-1' },
      { companyId: COMPANY_A, requesterId: EMPLOYEE_ID }
    );
    // The employee is told the outcome.
    expect(vi.mocked(insertNotifications).mock.calls[0][0][0].userId).toBe(EMPLOYEE_ID);
  });

  it('runs NOTHING on rejection', async () => {
    scenario();
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'rejected', 'No.');
    expect(res).toEqual({ ok: true, status: 'rejected' });
    expect(runApprovedAction).not.toHaveBeenCalled();
  });

  it('refuses a request whose grant was revoked while it waited', async () => {
    scenario();
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('revoked');
    // Approving a stale request must not resurrect a permission that was taken
    // away — this is the whole reason the check exists.
    expect(runApprovedAction).not.toHaveBeenCalled();
  });

  it('refuses a request that was already decided', async () => {
    scenario({ status: 'approved' });
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('already_decided');
    expect(runApprovedAction).not.toHaveBeenCalled();
  });

  it('loses the race safely when the claim update matches no pending row', async () => {
    // Two approvers clicking at once: the second finds nothing left to claim.
    scenario({ claimWins: false });
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('already_decided');
    expect(runApprovedAction).not.toHaveBeenCalled();
  });

  it('records a FAILED execution rather than reporting success', async () => {
    scenario();
    vi.mocked(runApprovedAction).mockResolvedValue({
      ok: false,
      error: 'That folder no longer exists.',
    } as never);

    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('execution_failed');

    // 'failed' is distinct from 'rejected': the approver said yes and the
    // action still did not land, and the row must say exactly that.
    const updates = stub.queries.filter((q) =>
      q.calls.some((c) => c.method === 'update')
    );
    const statuses = updates.map(
      (q) => (argOf(q, 'update') as { status?: string }).status
    );
    expect(statuses).toContain('failed');
  });

  it('survives an executor that throws, without a 500 escaping', async () => {
    scenario();
    vi.mocked(runApprovedAction).mockRejectedValue(new Error('boom'));
    const res = await decideApprovalRequest(REQUEST_ID, MANAGER_ID, 'approved', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('execution_failed');
  });
});
