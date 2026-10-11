import 'server-only';
import { getSupabaseAdmin } from './supabase';
import { hashPassword } from './password';
import type { Role } from './auth';

/**
 * Data-access layer for app_users. All queries go through the Supabase client
 * library, which sends parameterized requests to PostgREST — values are never
 * string-concatenated into SQL.
 */

export interface AppUser {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  created_at: string;
}

export interface AppUserWithHash extends AppUser {
  password_hash: string;
  /** Frozen accounts cannot sign in (migration #24). */
  is_frozen?: boolean | null;
}

/**
 * Look up a user by username OR email, for login.
 *
 * Usernames are matched exactly; emails are matched case-insensitively (emails
 * are stored lowercase-normalized on create). We run two parameterized queries
 * rather than a `.or()` filter string so no user input is interpolated into
 * PostgREST filter syntax — the client library sends values as parameters.
 */
export async function findUserByIdentifier(
  identifier: string
): Promise<AppUserWithHash | null> {
  const supabase = getSupabaseAdmin();
  const value = identifier.trim();
  // is_frozen is selected here so the login route can refuse a suspended
  // account without a second round trip.
  const columns =
    'id, username, email, role, created_at, password_hash, is_frozen';

  const byUsername = await supabase
    .from('app_users')
    .select(columns)
    .eq('username', value)
    .maybeSingle();
  if (byUsername.error) throw new Error(byUsername.error.message);
  if (byUsername.data) return byUsername.data as AppUserWithHash;

  const byEmail = await supabase
    .from('app_users')
    .select(columns)
    .eq('email', value.toLowerCase())
    .maybeSingle();
  if (byEmail.error) throw new Error(byEmail.error.message);
  return (byEmail.data as AppUserWithHash) ?? null;
}

/** Max rows returned by the users list (simple first-page cap; see UI note). */
export const USERS_PAGE_SIZE = 100;

/**
 * List users (admin view), newest first, capped at USERS_PAGE_SIZE. Selects only
 * the columns the UI needs — never the password hash. The `created_at desc`
 * ordering is backed by an index (see supabase/schema.sql).
 */
export async function listUsers(limit: number = USERS_PAGE_SIZE): Promise<AppUser[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('app_users')
    .select('id, username, email, role, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data as AppUser[]) ?? [];
}

export interface CreateUserInput {
  username: string;
  email?: string | null;
  password: string;
  role: Role;
}

/** Create a user with a bcrypt-hashed password. */
export async function createUser(input: CreateUserInput): Promise<AppUser> {
  const supabase = getSupabaseAdmin();
  const password_hash = await hashPassword(input.password);

  const { data, error } = await supabase
    .from('app_users')
    .insert({
      username: input.username.trim(),
      email: input.email?.trim().toLowerCase() || null,
      password_hash,
      role: input.role,
    })
    .select('id, username, email, role, created_at')
    .single();

  if (error) {
    // 23505 = unique_violation (duplicate username/email)
    if ((error as { code?: string }).code === '23505') {
      throw new DuplicateUserError('Username or email already exists.');
    }
    throw new Error(error.message);
  }
  return data as AppUser;
}

export class DuplicateUserError extends Error {}

/**
 * Freeze or unfreeze an account (migration #24).
 *
 * Freezing does two things, and the second is what makes it immediate:
 *   1. sets is_frozen, which the login route and getPlatformUser both refuse;
 *   2. bumps token_version, invalidating every session JWT already issued to
 *      that person — so anyone currently signed in is rejected on their very
 *      next request rather than lingering until the 12h expiry.
 *
 * Nothing is deleted. Their memberships, folders, tasks and history are
 * untouched, and unfreezing restores access exactly as it was.
 *
 * @returns false if the account row could not be updated.
 */
export async function setAccountFrozen(
  userId: string,
  frozen: boolean
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('app_users')
    .update({ is_frozen: frozen })
    .eq('id', userId);
  if (error) {
    console.error('setAccountFrozen failed:', error.message);
    return false;
  }
  // Kick any live session. Only needed when freezing — unfreezing does not
  // need to invalidate anything, and bumping there would sign the person out
  // of a session they are entitled to keep.
  if (frozen) {
    const revoked = await bumpTokenVersion(userId);
    if (!revoked) {
      // The flag is set, so getPlatformUser will still refuse them on the next
      // request; only the "instantly, on every device" part is degraded.
      console.error(
        'setAccountFrozen: token_version bump failed; freeze relies on the is_frozen check'
      );
    }
  }
  return true;
}

/**
 * Increment a user's token_version, invalidating all outstanding session JWTs
 * for that user (F2). Called on logout, and by the admin password-reset flow.
 *
 * @returns true only if the version was ACTUALLY incremented.
 *
 * It still never throws — a failure here must not block logout, because the
 * cookie is cleared locally either way. What it no longer does is fail
 * SILENTLY. Previously every error was swallowed and the caller reported an
 * unconditional success, so a transient Supabase 5xx during logout left the
 * JWT valid for the remainder of its 12-hour life while the user was told they
 * had signed out — with no signal to them, to an admin, or in the logs. Callers
 * now get the truth and can surface it.
 *
 * The read-then-write is not atomic, but concurrent bumps are harmless for the
 * purpose: any increment invalidates every previously issued token, so two
 * racing logouts both landing on N+1 still revoke correctly.
 */
export async function bumpTokenVersion(userId: string): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('app_users')
      .select('token_version')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) {
      // A missing token_version column means session revocation is not merely
      // degraded, it is entirely inoperative — worth a loud log line.
      console.error(
        'bumpTokenVersion: could not read token_version (revocation is NOT in effect)',
        error?.message ?? 'no such user'
      );
      return false;
    }
    const current =
      typeof (data as { token_version?: unknown }).token_version === 'number'
        ? (data as { token_version: number }).token_version
        : 0;
    const { error: updateError } = await supabase
      .from('app_users')
      .update({ token_version: current + 1 })
      .eq('id', userId);
    if (updateError) {
      console.error(
        'bumpTokenVersion: token_version write failed (outstanding sessions remain valid)',
        updateError.message
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error('bumpTokenVersion threw (outstanding sessions remain valid):', err);
    return false;
  }
}
