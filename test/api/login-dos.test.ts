import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * P0-2 regression suite at the route level.
 *
 * The unit tests in test/lib/rateLimit.test.ts prove the primitives behave.
 * These prove the LOGIN ROUTE actually uses them, and — the part that matters
 * for CPU — that a shed request is refused BEFORE any expensive work runs. If
 * the slot were acquired after the user lookup, an attacker would still get a
 * database round trip (and, worse, a bcrypt comparison) per request.
 */

vi.mock('@/lib/users', () => ({ findUserByIdentifier: vi.fn() }));
vi.mock('@/lib/password', () => ({ verifyPassword: vi.fn() }));
vi.mock('@/lib/session', () => ({ setSession: vi.fn() }));
vi.mock('@/lib/tokenVersion', () => ({ fetchTokenVersion: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({
  getPlatformUser: vi.fn(),
  landingForPlatformUser: vi.fn(() => '/admin'),
}));

const { findUserByIdentifier } = await import('@/lib/users');
const { verifyPassword } = await import('@/lib/password');
const { fetchTokenVersion } = await import('@/lib/tokenVersion');
const { getPlatformUser } = await import('@/lib/platform/auth');
const {
  __resetForTests,
  acquireVerificationSlot,
  verificationLoad,
} = await import('@/lib/rateLimit');
type VerificationSlot = Awaited<ReturnType<typeof acquireVerificationSlot>>;
const { POST } = await import('@/app/api/login/route');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function loginRequest(
  body: unknown,
  headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9' }
): NextRequest {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as NextRequest;
}

/** Fill every slot and every queue position, as a flood would. */
async function saturate() {
  const { maxConcurrent, maxQueued } = verificationLoad();
  const held: VerificationSlot[] = [];
  for (let i = 0; i < maxConcurrent; i++) held.push(await acquireVerificationSlot());
  const queued: Promise<VerificationSlot>[] = [];
  for (let i = 0; i < maxQueued; i++) queued.push(acquireVerificationSlot());
  await flush();
  return async () => {
    held.forEach((s) => s.release());
    for (const p of queued) (await p).release();
  };
}

beforeEach(() => {
  __resetForTests();
  vi.clearAllMocks();
  vi.mocked(findUserByIdentifier).mockResolvedValue(null);
  vi.mocked(verifyPassword).mockResolvedValue(false);
  vi.mocked(fetchTokenVersion).mockResolvedValue(0);
  vi.mocked(getPlatformUser).mockResolvedValue(null);
});

afterEach(() => {
  __resetForTests();
});

describe('POST /api/login — load shedding', () => {
  it('refuses with 503 once the process is saturated', async () => {
    const release = await saturate();

    const res = await POST(
      loginRequest({ identifier: 'probe@x.io', password: 'x' })
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    await release();
  });

  it('does no database work and no bcrypt for a shed request', async () => {
    // This is the whole point: a rejected request must cost ~0, or the attacker
    // still wins by paying one HTTP request for ~450ms of our CPU.
    const release = await saturate();

    await POST(loginRequest({ identifier: 'probe@x.io', password: 'x' }));

    expect(findUserByIdentifier).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
    await release();
  });

  it('serves normal traffic again as soon as capacity frees up', async () => {
    const release = await saturate();
    await release();

    const res = await POST(
      loginRequest({ identifier: 'probe@x.io', password: 'x' })
    );

    expect(res.status).toBe(401); // reached the real credential check
    expect(verifyPassword).toHaveBeenCalled();
  });

  it('always releases its slot, even when the lookup throws', async () => {
    // A leaked slot would permanently shrink capacity until the next deploy.
    vi.mocked(findUserByIdentifier).mockRejectedValue(new Error('db down'));

    const res = await POST(
      loginRequest({ identifier: 'probe@x.io', password: 'x' })
    );

    expect(res.status).toBe(500);
    expect(verificationLoad().active).toBe(0);
  });

  it('releases its slot on a successful login too', async () => {
    vi.mocked(findUserByIdentifier).mockResolvedValue({
      id: 'u1',
      username: 'u@x.io',
      email: 'u@x.io',
      role: 'user',
      created_at: '2026-01-01',
      password_hash: 'hash',
    });
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const res = await POST(loginRequest({ identifier: 'u@x.io', password: 'pw' }));

    expect(res.status).toBe(200);
    expect(verificationLoad().active).toBe(0);
  });
});

describe('POST /api/login — throttling is keyed on a value the caller cannot pick', () => {
  it('counts spoofed X-Forwarded-For prefixes into ONE bucket', async () => {
    // 10/min is the per-IP limit. Eleven requests from one real client, each
    // with a different spoofed prefix, must still trip it.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(
        loginRequest(
          { identifier: `probe-${i}@x.io`, password: 'x' },
          { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` }
        )
      );
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('does not let one attacker lock a known account for its real owner', async () => {
    const VICTIM = 'yp@albaker.qa';
    for (let i = 0; i < 8; i++) {
      await POST(
        loginRequest(
          { identifier: VICTIM, password: 'wrong' },
          { 'x-forwarded-for': `1.2.3.4, 203.0.113.66` }
        )
      );
    }

    // The owner, arriving from their own address, must still reach the
    // credential check rather than a 429.
    vi.mocked(findUserByIdentifier).mockResolvedValue({
      id: 'u1',
      username: VICTIM,
      email: VICTIM,
      role: 'admin',
      created_at: '2026-01-01',
      password_hash: 'hash',
    });
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const res = await POST(
      loginRequest(
        { identifier: VICTIM, password: 'correct' },
        { 'x-forwarded-for': '198.51.100.7' }
      )
    );

    expect(res.status).toBe(200);
  });
});
