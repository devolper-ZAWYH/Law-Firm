import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, MANAGER_ID, adminUser } from '../helpers/platformUser';
import { argOf, makeSupabaseStub, used } from '../helpers/supabase';

/**
 * THE RULE: once an approving manager is assigned, nothing changes it except an
 * admin deliberately choosing someone else or deliberately unselecting.
 *
 * WHAT WENT WRONG. The assignment survives the assigned person ceasing to be a
 * manager (correct — nothing should silently rewrite it). But Settings then
 * rendered a <select> with no <option> matching the stored id, so the control
 * fell back to its first entry, "— Nobody —". The admin saw "Nobody" while the
 * database said otherwise, and the next save re-sent the stale id into a
 * membership check that rejected it — 400, with the whole settings form stuck.
 * An admin who "fixed" the dropdown by picking a visible name reassigned the
 * role while believing it had been empty all along.
 *
 * So three properties are pinned here:
 *   1. An empty/absent field NEVER clears. Clearing takes an explicit flag.
 *   2. Re-sending the id that is ALREADY stored is always accepted, even if
 *      that person is no longer a manager — history must not brick the form.
 *   3. Changing to a DIFFERENT person still requires them to be a manager.
 */

let stub: ReturnType<typeof makeSupabaseStub>;

const OTHER_MANAGER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const STRANGER_ID = '99999999-9999-4999-8999-999999999999';

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/access', () => ({
  // MANAGER_ID and OTHER_MANAGER_ID are managers; nobody else is.
  listCompanyManagers: vi.fn(async () => [
    { userId: MANAGER_ID, username: 'm@albaker.io', fullNameEn: 'M', fullNameAr: null },
    { userId: OTHER_MANAGER_ID, username: 'o@albaker.io', fullNameEn: 'O', fullNameAr: null },
  ]),
}));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { PUT } = await import('@/app/api/companies/[id]/settings/route');

const ctx = { params: { id: COMPANY_A } };

/** A valid settings body; the approval field is layered on per test. */
function body(extra: Record<string, unknown> = {}) {
  return {
    working_days: [0, 1, 2, 3, 4],
    days_per_color_step: 3,
    alerts_enabled: true,
    telegram_enabled: false,
    ...extra,
  };
}
function req(b: Record<string, unknown>) {
  return { json: async () => b } as unknown as Parameters<typeof PUT>[0];
}

/** What the handler wrote to `companies`, or undefined if it wrote nothing. */
function written(): Record<string, unknown> | undefined {
  const q = stub.queries.find((x) => x.table === 'companies' && used(x, 'update'));
  return q ? (argOf(q, 'update') as Record<string, unknown>) : undefined;
}

/** The row the database currently holds, including who is assigned. */
function stored(approvalManagerId: string | null) {
  stub = makeSupabaseStub(() => ({
    data: {
      working_days: [0, 1, 2, 3, 4],
      days_per_color_step: 3,
      telegram_bot_token: null,
      telegram_chat_id: null,
      alerts_enabled: true,
      telegram_enabled: false,
      attendance_objection_approver_id: null,
      approval_manager_id: approvalManagerId,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  stored(MANAGER_ID);
  vi.mocked(getSession).mockResolvedValue({ sub: 'admin' } as never);
  vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
});

describe('an assigned approving manager persists', () => {
  it('is left alone when the field is absent entirely', async () => {
    const res = await PUT(req(body()), ctx);
    expect(res.status).toBe(200);
    expect(written()).not.toHaveProperty('approval_manager_id');
  });

  it('is NOT cleared by an empty string', async () => {
    // The blanked-<select> case. An empty value is indistinguishable from a
    // form that failed to render the current holder, so it must never clear.
    const res = await PUT(req(body({ approval_manager_id: '' })), ctx);
    expect(res.status).toBe(200);
    expect(written()).not.toHaveProperty('approval_manager_id');
  });

  it('is NOT cleared by whitespace either', async () => {
    const res = await PUT(req(body({ approval_manager_id: '   ' })), ctx);
    expect(res.status).toBe(200);
    expect(written()).not.toHaveProperty('approval_manager_id');
  });

  it('IS cleared when the admin explicitly unselects', async () => {
    const res = await PUT(
      req(body({ approval_manager_id: '', approval_manager_clear: true })),
      ctx
    );
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ approval_manager_id: null });
  });

  it('changes to another manager when the admin picks one', async () => {
    const res = await PUT(
      req(body({ approval_manager_id: OTHER_MANAGER_ID })),
      ctx
    );
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ approval_manager_id: OTHER_MANAGER_ID });
  });

  it('refuses a change to someone who is not a manager', async () => {
    const res = await PUT(req(body({ approval_manager_id: STRANGER_ID })), ctx);
    expect(res.status).toBe(400);
    expect(written()).toBeUndefined();
  });
});

describe('a stale assignment does not brick the settings form', () => {
  beforeEach(() => {
    // The assigned person has since stopped being a manager: still stored,
    // no longer in listCompanyManagers.
    stored(STRANGER_ID);
  });

  it('accepts a save that re-sends the id already stored', async () => {
    const res = await PUT(req(body({ approval_manager_id: STRANGER_ID })), ctx);
    expect(res.status).toBe(200);
  });

  it('leaves the stale assignment exactly as it was', async () => {
    await PUT(req(body({ approval_manager_id: STRANGER_ID })), ctx);
    const w = written();
    // Either untouched, or written back unchanged — never rewritten to
    // somebody else and never nulled.
    if (w && 'approval_manager_id' in w) {
      expect(w.approval_manager_id).toBe(STRANGER_ID);
    }
  });

  it('still lets the admin save unrelated settings', async () => {
    const res = await PUT(
      req(body({ days_per_color_step: 9, approval_manager_id: STRANGER_ID })),
      ctx
    );
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ days_per_color_step: 9 });
  });

  it('still lets the admin replace the stale holder with a real manager', async () => {
    const res = await PUT(req(body({ approval_manager_id: MANAGER_ID })), ctx);
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ approval_manager_id: MANAGER_ID });
  });

  it('still lets the admin unselect the stale holder outright', async () => {
    const res = await PUT(
      req(body({ approval_manager_id: '', approval_manager_clear: true })),
      ctx
    );
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ approval_manager_id: null });
  });
});
