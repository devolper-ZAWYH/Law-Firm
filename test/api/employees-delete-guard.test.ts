import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, adminUser, unusedRequest } from '../helpers/platformUser';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';

/**
 * P2-1 regression suite — the "does this person still hold open tasks?" guard
 * in DELETE /api/companies/:id/employees/:userId interpolated a URL path
 * segment into a PostgREST filter STRING:
 *
 *   .or(`assignee_id.eq.${userId},approver_id.eq.${userId}`)
 *
 * `.or()` takes raw filter syntax, so a crafted userId could rewrite the one
 * check standing between removing a membership and orphaning the tasks that
 * person still owns. Values given to .eq()/.in() are encoded as parameters by
 * supabase-js and cannot escape their slot.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { DELETE } = await import(
  '@/app/api/companies/[id]/employees/[userId]/route'
);

/** @param openTaskCount how many active tasks each counted query reports. */
function stubDb(openTaskCount: number) {
  const stub = makeSupabaseStub((q) => {
    if (q.table === 'memberships') return { data: { role: 'employee' } };
    if (q.table === 'files') return { data: [{ id: 'file-1' }] };
    if (q.table === 'tasks') return { count: openTaskCount, data: null };
    return { data: null };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  return stub;
}

const taskQueries = (queries: QueryRecord[]) => queries.filter((q) => q.table === 'tasks');

async function callDelete(userId: string) {
  const res = await DELETE(unusedRequest, {
    params: { id: COMPANY_A, userId },
  });
  return { res, body: (await res.json()) as { ok: boolean } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    id: 'admin',
    username: 'a',
    role: 'admin',
  });
  vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
});

describe('DELETE employees — open-task guard', () => {
  it('never builds a raw PostgREST filter string', async () => {
    const stub = stubDb(0);

    await callDelete(EMPLOYEE_ID);

    const usedOr = stub.queries.some((q) => q.calls.some((c) => c.method === 'or'));
    expect(usedOr).toBe(false);
  });

  it('checks assignee and approver as two parameterised queries', async () => {
    const stub = stubDb(0);

    await callDelete(EMPLOYEE_ID);

    const columns = taskQueries(stub.queries).flatMap((q) =>
      q.calls.filter((c) => c.method === 'eq').map((c) => c.args[0])
    );
    expect(columns).toContain('assignee_id');
    expect(columns).toContain('approver_id');
  });

  it('passes a hostile userId as a VALUE, never as syntax', async () => {
    // If this string were interpolated into a filter expression it would change
    // the query's meaning; as an .eq() argument it is just a (non-matching) id.
    const hostile = 'x,assignee_id.not.is.null,or=(id.gt.0)';
    const stub = stubDb(0);

    await callDelete(hostile);

    for (const q of stub.queries) {
      for (const call of q.calls) {
        expect(call.method).not.toBe('or');
      }
    }
    const eqValues = taskQueries(stub.queries).flatMap((q) =>
      q.calls.filter((c) => c.method === 'eq').map((c) => c.args[1])
    );
    expect(eqValues).toContain(hostile);
  });

  it('still refuses to remove someone holding open tasks', async () => {
    stubDb(3);

    const { res, body } = await callDelete(EMPLOYEE_ID);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
  });

  it('proceeds when the person holds none', async () => {
    const stub = stubDb(0);

    const { res, body } = await callDelete(EMPLOYEE_ID);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const deleted = stub.queries.filter((q) =>
      q.calls.some((c) => c.method === 'delete')
    );
    expect(deleted.map((q) => q.table)).toContain('memberships');
  });

  it('is still admin-only', async () => {
    stubDb(0);
    const { managerUser } = await import('../helpers/platformUser');
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res } = await callDelete(EMPLOYEE_ID);

    expect(res.status).toBe(403);
  });
});
