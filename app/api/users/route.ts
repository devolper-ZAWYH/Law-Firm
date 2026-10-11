import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin } from '@/lib/platform/auth';
import { createUser, listUsers, DuplicateUserError } from '@/lib/users';
import { rateLimit, clientIp } from '@/lib/rateLimit';
import type { Role } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ROLES: Role[] = ['admin', 'manager', 'user'];

/** GET /api/users — list users (admin only). */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  // Authorize via the platform model (global is_admin), not the legacy role.
  const pu = await getPlatformUser(session);
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const users = await listUsers();
    return NextResponse.json({ ok: true, users });
  } catch (err) {
    console.error('List users error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** POST /api/users — create a user (admin only). */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  // Authorize via the platform model (global is_admin), not the legacy role.
  const pu = await getPlatformUser(session);
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // Throttle account creation (F8): 20 per minute per IP.
  const rl = rateLimit(`users:create:${clientIp(req.headers)}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }

  let body: {
    email?: unknown;
    password?: unknown;
    role?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  // Accounts are keyed by email. Normalize to lowercase so login-by-email
  // (which matches the email column case-insensitively) is consistent.
  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role as Role;

  if (!email) {
    return NextResponse.json(
      { ok: false, error: 'Email is required.' },
      { status: 400 }
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid email address.' },
      { status: 400 }
    );
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { ok: false, error: 'Password must be at least 8 characters.' },
      { status: 400 }
    );
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid role.' },
      { status: 400 }
    );
  }

  try {
    // The DB requires a NOT NULL UNIQUE username; use the email as the username
    // so the account is keyed by email and login-by-email works.
    const created = await createUser({
      username: email,
      email,
      password,
      role,
    });
    return NextResponse.json({ ok: true, user: created }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    }
    console.error('Create user error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
