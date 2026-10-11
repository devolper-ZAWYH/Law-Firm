import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { fetchTokenVersion } from '@/lib/tokenVersion';

/**
 * Middleware does two jobs on every page request:
 *
 * 1. Content-Security-Policy with a per-request nonce (F4). This lets us drop
 *    'unsafe-inline' from script-src; Next.js reads the CSP we set on the
 *    request headers and stamps the nonce onto its own bootstrap scripts.
 *
 * 2. Coarse auth + session revocation for the protected areas:
 *    - Unauthenticated on a protected route  -> redirect to /login
 *    - Authenticated on /login               -> redirect to / (which resolves
 *      the platform landing: /admin for admins/managers, /me for employees)
 *    - Revoked token (token_version bumped, F2) -> treated as unauthenticated;
 *      the stale cookie is cleared so there is no redirect loop.
 *
 * FINE-GRAINED authorization (is_admin + memberships, per the two-layer model)
 * is enforced SERVER-SIDE in the page components via lib/platform/auth.ts — the
 * membership data is not in the JWT, so it cannot be checked at the edge.
 * Middleware only guarantees "is authenticated" for protected routes; the page
 * guards redirect the wrong bucket (e.g. an employee reaching /admin -> /me).
 *
 * verifySessionToken is edge-safe (jose, no DB). fetchTokenVersion does a
 * fail-open REST read for revocation (null => keep the session).
 */

// '/collections' is the second portal (migration #34). Like the other two, this
// only guarantees "is authenticated" — whether the caller may actually open
// PayLater is resolved server-side by paylaterAccess() in the page itself,
// because the grant lives in the database and not in the JWT.
const PROTECTED_PREFIXES = ['/admin', '/me', '/collections'];

/** Methods that never mutate state, so they need no cross-origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Extra origins permitted to make state-changing API calls, comma-separated.
 * Empty by default: only the origin the request was addressed to is allowed.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

/**
 * True if this is a browser-issued request from another origin.
 *
 * Requests with NO Origin header are allowed through: browsers always send
 * Origin on cross-origin state-changing requests, so a missing one means a
 * non-browser client (curl, a server-side integration, a mobile app), which
 * CSRF does not apply to and which we must not break.
 */
function isCrossOriginWrite(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // unparseable Origin — refuse rather than guess
  }
  // Compare against the host the request was actually addressed to, accepting
  // either the literal Host or the forwarded one the edge set.
  const hosts = [req.headers.get('host'), req.headers.get('x-forwarded-host')]
    .filter((h): h is string => !!h)
    .map((h) => h.trim());
  return !hosts.includes(originHost);
}

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      isDev ? " 'unsafe-eval'" : ''
    }`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // --- API routes: cross-origin write guard, then straight through ---
  //
  // The session cookie is SameSite=Lax, which already blocks cross-SITE POSTs.
  // What Lax does NOT cover is a same-site request from a different ORIGIN:
  // every *.albaker.io subdomain counts as same-site, so anything running on
  // one could drive authenticated state changes here. There is no CSRF token in
  // the app, so this Origin check is the control that closes that gap.
  //
  // Deliberately returns BEFORE the CSP/auth work below: API responses are JSON
  // (no CSP needed) and each route handler runs its own getSession(). Falling
  // through would add a per-request fetchTokenVersion round trip to every API
  // call for no benefit.
  if (pathname.startsWith('/api/')) {
    if (isCrossOriginWrite(req)) {
      return NextResponse.json(
        { ok: false, error: 'Cross-origin request refused.' },
        { status: 403 }
      );
    }
    return NextResponse.next();
  }

  // --- CSP nonce (all matched page requests) ---
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const pass = () =>
    NextResponse.next({ request: { headers: requestHeaders } });
  const withCsp = (res: NextResponse) => {
    res.headers.set('content-security-policy', csp);
    return res;
  };
  const clearCookie = (res: NextResponse) => {
    res.cookies.set(SESSION_COOKIE, '', { maxAge: 0, path: '/' });
    return res;
  };

  // --- Auth + revocation ---
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = await verifySessionToken(token);

  // Revocation check (fail-open): only when a valid-looking token is present.
  let authed = claims;
  if (claims) {
    const current = await fetchTokenVersion(claims.id);
    if (current !== null && current !== claims.ver) authed = null; // revoked
  }

  // Keep authenticated users off /login. Root (/) resolves the correct landing.
  if (pathname === '/login') {
    if (authed) {
      return withCsp(NextResponse.redirect(new URL('/', req.url)));
    }
    // Present-but-revoked token: clear it so the login page works cleanly.
    return withCsp(token && !authed ? clearCookie(pass()) : pass());
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );

  // Public (non-protected) page: just apply CSP.
  if (!isProtected) return withCsp(pass());

  // Protected route: require authentication. Role/company authorization is
  // enforced server-side in the page components.
  if (!authed) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    const res = NextResponse.redirect(loginUrl);
    if (token) clearCookie(res); // drop a stale/revoked cookie
    return withCsp(res);
  }

  return withCsp(pass());
}

export const config = {
  // Run on all page routes so CSP applies everywhere, AND on /api so the
  // cross-origin write guard above covers every route handler in one place
  // (they are otherwise reached without any middleware at all). Next internals
  // and static assets are still skipped — no auth/CSP/DB work is needed there.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|albaker-logo.png|robots.txt|sitemap.xml).*)',
  ],
};
