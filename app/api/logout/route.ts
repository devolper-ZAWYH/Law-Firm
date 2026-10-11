import { NextResponse } from 'next/server';
import { getSession, clearSession } from '@/lib/session';
import { bumpTokenVersion } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/logout — clear the cookie AND revoke every outstanding token.
 *
 * `revoked` reports whether server-side revocation actually happened. The cookie
 * is always cleared, so the browser in front of us is signed out either way —
 * but if the token_version bump failed (a transient Supabase error, or the
 * column never migrated), a copy of the JWT taken from this machine stays valid
 * until it expires 12h after issue. This route used to swallow that case and
 * return an unconditional `{ ok: true }`, which made "sign out everywhere" a
 * promise it could silently break. The client surfaces the difference now.
 */
export async function POST() {
  const session = await getSession();
  const revoked = session ? await bumpTokenVersion(session.id) : true;
  clearSession();
  return NextResponse.json({ ok: true, revoked });
}
