import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * Session helpers. The session is a signed (HS256) JWT stored in an httpOnly
 * cookie. It carries the user's id, username, and role, and expires after 12h.
 *
 * This module is edge-safe (uses `jose`, no Node-only APIs) so it can be used
 * from middleware as well as route handlers and Server Components.
 */

export const SESSION_COOKIE = 'albaker_session';
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

export type Role = 'admin' | 'manager' | 'user';

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
}

/** Session claims as verified from the JWT — includes the token version (F2). */
export interface SessionToken extends SessionUser {
  ver: number;
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (need >= 32 chars). Generate with: openssl rand -base64 48'
    );
  }
  return new TextEncoder().encode(secret);
}

/** Create a signed session token for a user, stamped with its token version. */
export async function createSessionToken(
  user: SessionUser,
  tokenVersion: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: user.username, role: user.role, ver: tokenVersion })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_MAX_AGE_SECONDS)
    .sign(getSecret());
}

/**
 * Verify a session token's signature/expiry/claims and return them, or null if
 * invalid/expired. This performs NO database access (edge-safe). Revocation
 * (token-version) is checked separately by callers via fetchTokenVersion().
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionToken | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });
    return sessionFromPayload(payload);
  } catch {
    return null;
  }
}

function sessionFromPayload(payload: JWTPayload): SessionToken | null {
  const id = payload.sub;
  const username = payload.username;
  const role = payload.role;
  const ver = payload.ver;
  if (
    typeof id !== 'string' ||
    typeof username !== 'string' ||
    (role !== 'admin' && role !== 'manager' && role !== 'user')
  ) {
    return null;
  }
  // Old tokens minted before F2 have no `ver`; treat as 0 (matches the column
  // default) so they remain valid until natural expiry.
  return { id, username, role, ver: typeof ver === 'number' ? ver : 0 };
}

/** The dashboard landing route for a given role. */
export function homeForRole(role: Role): string {
  switch (role) {
    case 'admin':
      return '/admin';
    case 'manager':
      return '/manager';
    default:
      return '/user';
  }
}
