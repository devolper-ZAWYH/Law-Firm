import { NextResponse, type NextRequest } from 'next/server';
import { findUserByIdentifier } from '@/lib/users';
import { verifyPassword } from '@/lib/password';
import { setSession } from '@/lib/session';
import { getPlatformUser, landingForPlatformUser } from '@/lib/platform/auth';
import { paylaterAccess } from '@/lib/platform/paylater';
import { ONLY_COMPANY_NAME_EN } from '@/lib/platform/singleCompany';
import { fetchTokenVersion } from '@/lib/tokenVersion';
import {
  rateLimit,
  clientIp,
  accountLockStatus,
  recordFailedAttempt,
  clearFailedAttempts,
  acquireVerificationSlot,
} from '@/lib/rateLimit';

export const runtime = 'nodejs'; // bcryptjs + service-role client need Node runtime
export const dynamic = 'force-dynamic';

// Generic message so we never reveal whether a username/email exists.
const INVALID = 'Invalid credentials.';
const TOO_MANY = 'Too many attempts. Please try again shortly.';
const BUSY = 'The service is busy. Please try again in a moment.';
const DISABLED =
  'This account has been disabled. Please contact your administrator. / تم تعطيل هذا الحساب. يرجى التواصل مع المسؤول.';

export async function POST(req: NextRequest) {
  // Layer 1 — coarse per-IP rate limit: 10 attempts per minute per IP. clientIp
  // reads the hop our own edge appended, so this bucket cannot be chosen by the
  // caller (see lib/rateLimit.ts).
  const ip = clientIp(req.headers);
  const ipRl = rateLimit(`login:ip:${ip}`, 10, 60_000);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { ok: false, error: TOO_MANY },
      { status: 429, headers: { 'Retry-After': String(ipRl.retryAfterSeconds) } }
    );
  }

  let body: { identifier?: unknown; password?: unknown; portal?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: INVALID }, { status: 400 });
  }

  const identifier =
    typeof body.identifier === 'string' ? body.identifier.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  // The portal preference. Anything unrecognised means the main portal — an
  // unknown value must not become a way to probe for a second one.
  const wantsPaylater = body.portal === 'paylater';

  if (!identifier || !password) {
    return NextResponse.json({ ok: false, error: INVALID }, { status: 400 });
  }

  // Layer 2 — account lockout, in two tiers: this source against this account,
  // then the account across all sources (see lib/rateLimit.ts).
  const account = identifier.toLowerCase();
  const lock = accountLockStatus(account, ip);
  if (lock.locked) {
    return NextResponse.json(
      { ok: false, error: TOO_MANY },
      { status: 429, headers: { 'Retry-After': String(lock.retryAfterSeconds) } }
    );
  }

  // Layer 3 — the global CPU bound. Acquired BEFORE the user lookup so a shed
  // request costs neither a bcrypt comparison (~450ms of event-loop time) nor a
  // database round trip. Layers 1 and 2 are both keyed on something the caller
  // influences; this one is not, so it is what actually caps the damage when an
  // attacker varies both the source address and the identifier.
  const slot = await acquireVerificationSlot();
  if (!slot.ok) {
    return NextResponse.json(
      { ok: false, error: BUSY },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  try {
    const user = await findUserByIdentifier(identifier);

    // Always run bcrypt (against a decoy hash if the user is absent) so response
    // timing does not reveal account existence (F6).
    const valid = await verifyPassword(password, user?.password_hash);
    if (!user || !valid) {
      recordFailedAttempt(account, ip);
      return NextResponse.json({ ok: false, error: INVALID }, { status: 401 });
    }

    // Frozen account (migration #24). Checked AFTER the password comparison on
    // purpose: answering before it would let anyone discover which addresses
    // belong to suspended staff without knowing a password.
    if (user.is_frozen === true) {
      return NextResponse.json({ ok: false, error: DISABLED }, { status: 403 });
    }

    clearFailedAttempts(account, ip);

    // Stamp the session with the user's current token version (revocation, F2).
    const ver = (await fetchTokenVersion(user.id)) ?? 0;
    await setSession(
      { id: user.id, username: user.username, role: user.role },
      ver
    );

    // Resolve the platform landing (is_admin + memberships). If resolution
    // fails, fall back to /admin — the /admin server guard self-corrects and
    // redirects non-admin/non-manager callers to /me.
    let redirectTo = '/admin';
    let notice: string | undefined;
    try {
      const pu = await getPlatformUser({ id: user.id });
      if (pu) {
        redirectTo = landingForPlatformUser(pu);

        // THE PORTAL CHOICE IS RESOLVED HERE, AFTER THE PASSWORD.
        //
        // Nothing above this point has looked at it, so an unauthenticated
        // caller learns nothing about who has PayLater access — the response
        // to a wrong password is identical whichever portal was picked.
        //
        // A refused portal is NOT a refused sign-in. The session is already
        // established; the person simply does not have PayLater, so they land
        // in the main portal with a plain sentence saying so, rather than a red
        // error for a boundary that is working exactly as intended.
        if (wantsPaylater) {
          const company = pu.companies.find(
            (c) => c.nameEn === ONLY_COMPANY_NAME_EN
          ) ?? pu.companies[0];

          const access = company
            ? await paylaterAccess(pu, company.id)
            : null;

          if (access?.canOpen) {
            redirectTo = '/collections';
          } else {
            notice =
              'You do not have access to the PayLater portal. Signing you in to the main portal. / ليس لديك صلاحية الدخول إلى بوابة باي لاتر. سيتم تسجيل دخولك إلى البوابة الرئيسية.';
          }
        }
      }
    } catch (e) {
      console.error('Platform resolution failed at login:', e);
    }

    return NextResponse.json({ ok: true, redirect: redirectTo, notice });
  } catch (err) {
    console.error('Login error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  } finally {
    slot.release();
  }
}
