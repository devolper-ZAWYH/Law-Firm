import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * P2-2 regression suite — cross-origin state-changing API requests.
 *
 * The session cookie is SameSite=Lax, which blocks cross-SITE POSTs but treats
 * every *.albaker.io subdomain as same-site. With no CSRF token anywhere in the
 * app, anything running on a subdomain could drive authenticated writes. The
 * API was also excluded from the middleware matcher entirely, so no shared
 * control existed to add this to.
 */

vi.mock('@/lib/auth', () => ({
  SESSION_COOKIE: 'albaker_session',
  verifySessionToken: vi.fn(async () => null),
}));
vi.mock('@/lib/tokenVersion', () => ({ fetchTokenVersion: vi.fn(async () => null) }));

const { middleware, config } = await import('@/middleware');

function apiRequest(opts: {
  method: string;
  path?: string;
  origin?: string;
  host?: string;
}): NextRequest {
  const host = opts.host ?? 'albaker.io';
  const path = opts.path ?? '/api/files';
  const headers = new Headers({ host });
  if (opts.origin) headers.set('origin', opts.origin);
  return {
    method: opts.method,
    headers,
    nextUrl: { pathname: path },
    url: `https://${host}${path}`,
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

describe('middleware — cross-origin API writes', () => {
  it('refuses a POST from another origin', async () => {
    const res = await middleware(
      apiRequest({ method: 'POST', origin: 'https://evil.albaker.io' })
    );

    expect(res.status).toBe(403);
  });

  it('refuses PATCH and DELETE from another origin too', async () => {
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      const res = await middleware(
        apiRequest({ method, origin: 'https://attacker.example' })
      );
      expect(res.status).toBe(403);
    }
  });

  it('allows a same-origin write — the normal dashboard path', async () => {
    const res = await middleware(
      apiRequest({ method: 'POST', origin: 'https://albaker.io', host: 'albaker.io' })
    );

    expect(res.status).not.toBe(403);
  });

  it('allows a write with NO Origin header', async () => {
    // Browsers always send Origin on cross-origin writes, so a missing one is a
    // non-browser client (curl, a server-side job). Refusing those would break
    // legitimate integrations without adding CSRF protection.
    const res = await middleware(apiRequest({ method: 'POST' }));

    expect(res.status).not.toBe(403);
  });

  it('never blocks a cross-origin GET', async () => {
    const res = await middleware(
      apiRequest({ method: 'GET', origin: 'https://evil.albaker.io' })
    );

    expect(res.status).not.toBe(403);
  });

  it('refuses an unparseable Origin rather than guessing', async () => {
    const res = await middleware(
      apiRequest({ method: 'POST', origin: 'not a url' })
    );

    expect(res.status).toBe(403);
  });

  it('does not hit the database on an API request', async () => {
    // The guard returns before the auth/CSP work. If it fell through, every API
    // call would pay a fetchTokenVersion round trip it never needed.
    const { fetchTokenVersion } = await import('@/lib/tokenVersion');
    vi.mocked(fetchTokenVersion).mockClear();

    await middleware(apiRequest({ method: 'GET' }));

    expect(fetchTokenVersion).not.toHaveBeenCalled();
  });
});

describe('middleware — matcher coverage', () => {
  it('no longer excludes /api, or the guard above would never run', async () => {
    const matcher = config.matcher[0];

    expect(matcher).not.toContain('api|');
    // Static assets are still skipped.
    expect(matcher).toContain('_next/static');
  });
});
