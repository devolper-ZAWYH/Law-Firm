import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, argOf } from '../helpers/supabase';

/**
 * Account freeze (migration #24).
 *
 * A frozen account must not be able to sign in, and anyone already signed in
 * must stop working immediately rather than lingering until their 12h JWT
 * expires. That is enforced in two independent places, and both are tested:
 *
 *   1. the login route refuses a frozen account;
 *   2. getPlatformUser returns null for one, so every protected page and API
 *      route rejects the request even if the token-version revocation failed.
 */

vi.mock('@/lib/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/users')>();
  return { ...actual, findUserByIdentifier: vi.fn() };
});
vi.mock('@/lib/password', () => ({ verifyPassword: vi.fn() }));
vi.mock('@/lib/session', () => ({ setSession: vi.fn(), getSession: vi.fn() }));
vi.mock('@/lib/tokenVersion', () => ({ fetchTokenVersion: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));

const { findUserByIdentifier } = await import('@/lib/users');
const { verifyPassword } = await import('@/lib/password');
const { fetchTokenVersion } = await import('@/lib/tokenVersion');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { __resetForTests } = await import('@/lib/rateLimit');
const { POST: LOGIN } = await import('@/app/api/login/route');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { setAccountFrozen } = await import('@/lib/users');

const ACTIVE = {
  id: 'u1',
  username: 'jasim@albaker.qa',
  email: 'jasim@albaker.qa',
  role: 'user' as const,
  created_at: '2026-01-01',
  password_hash: 'hash',
  is_frozen: false,
};
const FROZEN = { ...ACTIVE, is_frozen: true };

function loginRequest(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }),
    json: async () => body,
  } as unknown as NextRequest;
}

const creds = { identifier: 'jasim@albaker.qa', password: 'correct-password' };

beforeEach(() => {
  __resetForTests();
  vi.clearAllMocks();
  vi.mocked(verifyPassword).mockResolvedValue(true);
  vi.mocked(fetchTokenVersion).mockResolvedValue(0);
});

describe('login — frozen accounts', () => {
  it('lets an active account sign in', async () => {
    vi.mocked(findUserByIdentifier).mockResolvedValue(ACTIVE);

    const res = await LOGIN(loginRequest(creds));

    expect(res.status).toBe(200);
  });

  it('refuses a frozen account even with the CORRECT password', async () => {
    vi.mocked(findUserByIdentifier).mockResolvedValue(FROZEN);

    const res = await LOGIN(loginRequest(creds));
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/disabled/i);
  });

  it('issues no session for a frozen account', async () => {
    const { setSession } = await import('@/lib/session');
    vi.mocked(findUserByIdentifier).mockResolvedValue(FROZEN);

    await LOGIN(loginRequest(creds));

    expect(setSession).not.toHaveBeenCalled();
  });

  it('still checks the password BEFORE revealing that an account is frozen', async () => {
    // Otherwise anyone could discover which addresses belong to suspended
    // staff without knowing a password.
    vi.mocked(findUserByIdentifier).mockResolvedValue(FROZEN);
    vi.mocked(verifyPassword).mockResolvedValue(false);

    const res = await LOGIN(loginRequest({ ...creds, password: 'wrong' }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(body.error).not.toMatch(/disabled/i);
  });
});

describe('getPlatformUser — frozen accounts are treated as signed out', () => {
  function stubUser(row: Record<string, unknown> | null) {
    const stub = makeSupabaseStub((q) => {
      if (q.table === 'app_users') return { data: row };
      return { data: [] };
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  }

  const base = {
    id: 'u1',
    username: 'jasim@albaker.qa',
    is_admin: false,
    full_name_en: 'Jassim',
    full_name_ar: 'جاسم',
  };

  it('resolves an active account normally', async () => {
    stubUser({ ...base, is_frozen: false });

    const pu = await getPlatformUser({ id: 'u1' });

    expect(pu).not.toBeNull();
    expect(pu?.userId).toBe('u1');
  });

  it('returns null for a frozen account, so every guard rejects the request', async () => {
    // This is the belt to token-version revocation's braces: even if the bump
    // failed, the freeze still takes effect on the very next request.
    stubUser({ ...base, is_frozen: true });

    const pu = await getPlatformUser({ id: 'u1' });

    expect(pu).toBeNull();
  });

  it('treats a null flag as not frozen (rows predating the migration)', async () => {
    stubUser({ ...base, is_frozen: null });

    expect(await getPlatformUser({ id: 'u1' })).not.toBeNull();
  });
});

describe('setAccountFrozen', () => {
  it('sets the flag and revokes live sessions when freezing', async () => {
    const stub = makeSupabaseStub((q) => {
      if (q.table === 'app_users' && q.calls.some((c) => c.method === 'select')) {
        return { data: { token_version: 4 } };
      }
      return { error: null, data: null };
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    await expect(setAccountFrozen('u1', true)).resolves.toBe(true);

    const updates = stub.queries.filter((q) => q.calls.some((c) => c.method === 'update'));
    const payloads = updates.map((q) => argOf(q, 'update'));
    // Both the flag and the session revocation.
    expect(payloads).toContainEqual({ is_frozen: true });
    expect(payloads).toContainEqual({ token_version: 5 });
  });

  it('does NOT revoke sessions when unfreezing', async () => {
    // Restoring access should not also sign the person out of a session they
    // are entitled to keep.
    //
    // The stub deliberately RETURNS a token_version row, so bumpTokenVersion
    // would be able to write if it were called. An earlier version of this test
    // returned null here, which made the bump bail out before writing — the
    // assertion then passed even when the code did call it.
    const stub = makeSupabaseStub((q) => {
      if (q.table === 'app_users' && q.calls.some((c) => c.method === 'select')) {
        return { data: { token_version: 4 } };
      }
      return { error: null, data: null };
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    await setAccountFrozen('u1', false);

    const payloads = stub.queries
      .filter((q) => q.calls.some((c) => c.method === 'update'))
      .map((q) => argOf(q, 'update'));
    expect(payloads).toContainEqual({ is_frozen: false });
    expect(payloads.some((p) => p && 'token_version' in (p as object))).toBe(false);
  });

  it('reports failure rather than throwing', async () => {
    const stub = makeSupabaseStub(() => ({ error: { message: 'boom' } }));
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    await expect(setAccountFrozen('u1', true)).resolves.toBe(false);
  });
});
