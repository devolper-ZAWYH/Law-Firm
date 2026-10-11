import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * P1-6 regression suite — session revocation failed open, silently.
 *
 * bumpTokenVersion swallowed every error and returned void; the logout route
 * then reported an unconditional `{ ok: true }`. A transient Supabase error
 * during logout therefore left the JWT valid for the rest of its 12-hour life
 * while telling the user they had signed out — with no signal anywhere.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  clearSession: vi.fn(),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getSession, clearSession } = await import('@/lib/session');
const { bumpTokenVersion } = await import('@/lib/users');
const { POST } = await import('@/app/api/logout/route');

const SESSION = { id: 'user-1', username: 'u@albaker.io', role: 'admin' as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION);
});

/** Wire a stub whose read succeeds and whose update outcome is configurable. */
function stubDb(opts: { readError?: unknown; updateError?: unknown; row?: unknown }) {
  const stub = makeSupabaseStub((q) => {
    const isUpdate = q.calls.some((c) => c.method === 'update');
    if (isUpdate) return { error: opts.updateError ?? null };
    if (opts.readError) return { error: opts.readError };
    return { data: opts.row ?? { token_version: 4 } };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  return stub;
}

describe('bumpTokenVersion — reports what actually happened', () => {
  it('returns true when the version is incremented', async () => {
    stubDb({});

    await expect(bumpTokenVersion('user-1')).resolves.toBe(true);
  });

  it('increments from the current value', async () => {
    const stub = stubDb({ row: { token_version: 4 } });

    await bumpTokenVersion('user-1');

    const update = stub.queries.find((q) => q.calls.some((c) => c.method === 'update'));
    const payload = update?.calls.find((c) => c.method === 'update')?.args[0];
    expect(payload).toEqual({ token_version: 5 });
  });

  it('returns false when the WRITE fails', async () => {
    // The case that used to be invisible.
    stubDb({ updateError: { message: 'connection reset' } });

    await expect(bumpTokenVersion('user-1')).resolves.toBe(false);
  });

  it('returns false when token_version cannot be read', async () => {
    stubDb({ readError: { message: 'column does not exist', code: '42703' } });

    await expect(bumpTokenVersion('user-1')).resolves.toBe(false);
  });

  it('returns false rather than throwing when the client blows up', async () => {
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error('not configured');
    });

    await expect(bumpTokenVersion('user-1')).resolves.toBe(false);
  });
});

describe('POST /api/logout', () => {
  it('reports revoked: true on a clean logout', async () => {
    stubDb({});

    const res = await POST();
    const body = (await res.json()) as { ok: boolean; revoked: boolean };

    expect(body).toEqual({ ok: true, revoked: true });
  });

  it('reports revoked: false when revocation did not happen', async () => {
    stubDb({ updateError: { message: 'connection reset' } });

    const res = await POST();
    const body = (await res.json()) as { ok: boolean; revoked: boolean };

    expect(body.revoked).toBe(false);
  });

  it('still clears the cookie even when revocation fails', async () => {
    // This browser must always end up signed out; only the "everywhere" part
    // of the promise is in doubt.
    stubDb({ updateError: { message: 'connection reset' } });

    await POST();

    expect(clearSession).toHaveBeenCalled();
  });

  it('does not attempt revocation with no session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    stubDb({});

    const res = await POST();
    const body = (await res.json()) as { revoked: boolean };

    expect(body.revoked).toBe(true);
    expect(clearSession).toHaveBeenCalled();
  });
});
