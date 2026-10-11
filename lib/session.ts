import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifySessionToken,
  homeForRole,
  type Role,
  type SessionUser,
} from './auth';
import { fetchTokenVersion } from './tokenVersion';

/**
 * Server-side session cookie helpers, for use in Route Handlers and Server
 * Components (they rely on next/headers `cookies()`).
 */

const baseCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * Read and verify the current session from the request cookies, including the
 * token-version revocation check (F2). Returns null if the token is invalid,
 * expired, or has been revoked (version bumped on logout / password change).
 * Fail-open: if the version cannot be determined, the session is kept.
 */
export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const current = await fetchTokenVersion(claims.id);
  if (current !== null && current !== claims.ver) return null; // revoked

  return { id: claims.id, username: claims.username, role: claims.role };
}

/** Issue a fresh session cookie for the given user (called on login). */
export async function setSession(
  user: SessionUser,
  tokenVersion: number
): Promise<void> {
  const token = await createSessionToken(user, tokenVersion);
  cookies().set(SESSION_COOKIE, token, {
    ...baseCookie,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Clear the session cookie (called on logout). */
export function clearSession(): void {
  cookies().set(SESSION_COOKIE, '', { ...baseCookie, maxAge: 0 });
}

/**
 * Require an authenticated session (optionally with a specific role) inside a
 * Server Component. Middleware already enforces this at the edge; this is
 * defense-in-depth and gives pages a typed, guaranteed-present user.
 */
export async function requireRole(role?: Role): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (role && session.role !== role) redirect(homeForRole(session.role));
  return session;
}
