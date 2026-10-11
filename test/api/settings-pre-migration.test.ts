import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, adminUser, unusedRequest } from '../helpers/platformUser';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';

/**
 * GET/PUT /api/companies/:id/settings against a database that has NOT yet run
 * migration #31 (approval_manager_id).
 *
 * THIS IS A REGRESSION TEST FOR A REAL OUTAGE. The column was added to the
 * SELECT list without a fallback, and PostgREST fails the WHOLE query for one
 * unknown column — so this endpoint 500'd for every signed-in user until the
 * migration landed. New code is always deployed before its migration runs, so
 * "the column isn't there yet" is a state every such read must survive, not an
 * edge case.
 */

let stub: ReturnType<typeof makeSupabaseStub>;
let resolve: (q: QueryRecord) => { data?: unknown; error?: unknown };

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/access', () => ({
  listCompanyManagers: vi.fn(async () => [
    { userId: 'mgr-1', username: 'm@x.io', fullNameEn: 'M', fullNameAr: 'م' },
  ]),
}));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { GET, PUT } = await import('@/app/api/companies/[id]/settings/route');

const ctx = { params: { id: COMPANY_A } };

const ROW = {
  working_days: [0, 1, 2, 3, 4],
  days_per_color_step: 3,
  telegram_bot_token: null,
  telegram_chat_id: null,
  alerts_enabled: true,
  telegram_enabled: false,
  attendance_objection_approver_id: null,
};

/** PostgREST's answer when a selected column is not in its schema cache. */
const MISSING_COLUMN = {
  code: '42703',
  message: 'column companies.approval_manager_id does not exist',
};

function askedForApprovalManager(q: QueryRecord): boolean {
  return q.calls.some(
    (c) =>
      c.method === 'select' && String(c.args[0] ?? '').includes('approval_manager_id')
  );
}

function putBody(extra: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      working_days: [0, 1, 2, 3, 4],
      days_per_color_step: 3,
      ...extra,
    }),
  } as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeSupabaseStub((q) => resolve(q));
  vi.mocked(getSession).mockResolvedValue({ sub: 'admin' } as never);
  vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
});

describe('GET settings before migration #31', () => {
  beforeEach(() => {
    // Fails the query that asks for the new column; succeeds without it.
    resolve = (q) => (askedForApprovalManager(q) ? { error: MISSING_COLUMN } : { data: ROW });
  });

  it('returns 200 instead of 500', async () => {
    const res = await GET(unusedRequest, ctx);
    expect(res.status).toBe(200);
  });

  it('reports the approver as unassigned, which is what it is', async () => {
    const res = await GET(unusedRequest, ctx);
    const body = await res.json();
    expect(body.settings.approval_manager_id).toBe('');
  });

  it('still returns every other setting', async () => {
    const res = await GET(unusedRequest, ctx);
    const body = await res.json();
    expect(body.settings.working_days).toEqual([0, 1, 2, 3, 4]);
    expect(body.settings.days_per_color_step).toBe(3);
    expect(body.settings.alerts_enabled).toBe(true);
  });

  it('surfaces a REAL database error rather than hiding it behind the fallback', async () => {
    resolve = () => ({ error: { code: '08006', message: 'connection failure' } });
    const res = await GET(unusedRequest, ctx);
    expect(res.status).toBe(500);
  });
});

describe('PUT settings before migration #31', () => {
  it('saves the other settings rather than losing the whole form', async () => {
    let updates = 0;
    resolve = (q) => {
      if (q.calls.some((c) => c.method === 'update')) {
        updates += 1;
        // The first attempt includes the missing column.
        const patch = argOf(q, 'update') as Record<string, unknown>;
        if ('approval_manager_id' in patch) return { error: MISSING_COLUMN };
        return { data: null };
      }
      return { data: ROW };
    };

    const res = await PUT(putBody({ approval_manager_id: 'mgr-1' }), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(updates).toBe(2); // tried with the column, then retried without
    expect(body.ok).toBe(true);
  });

  it('does NOT claim the approver was stored when it could not be', async () => {
    resolve = (q) => {
      if (q.calls.some((c) => c.method === 'update')) {
        const patch = argOf(q, 'update') as Record<string, unknown>;
        if ('approval_manager_id' in patch) return { error: MISSING_COLUMN };
        return { data: null };
      }
      return { data: ROW };
    };

    const body = await (await PUT(putBody({ approval_manager_id: 'mgr-1' }), ctx)).json();
    // Silently "succeeding" would leave an admin believing gated permissions
    // are usable when nothing can approve them.
    expect(body.warning).toBe('not_migrated');
    expect(body.error).toMatch(/approving manager could not be/i);
  });

  it('does not warn when no approver was being set', async () => {
    resolve = (q) => {
      if (q.calls.some((c) => c.method === 'update')) {
        const patch = argOf(q, 'update') as Record<string, unknown>;
        if ('approval_manager_id' in patch) return { error: MISSING_COLUMN };
        return { data: null };
      }
      return { data: ROW };
    };

    const body = await (await PUT(putBody(), ctx)).json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
  });
});
