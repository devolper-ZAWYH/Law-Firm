import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/**
 * A valid, precomputed bcrypt hash used as a decoy when a login identifier does
 * not exist, so `verifyPassword` still performs a real (slow) comparison and
 * the response timing does not reveal whether an account exists (F6, CWE-208).
 * Computed once per process at import; the plaintext is a throwaway constant.
 */
const DUMMY_HASH = bcrypt.hashSync('albaker-timing-guard-not-a-real-password', SALT_ROUNDS);

/** Hash a plaintext password with bcrypt. Never store plaintext. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a stored bcrypt hash. If `hash` is
 * missing/empty (user not found), compare against DUMMY_HASH so timing is
 * constant-ish and always returns false.
 */
export function verifyPassword(
  plain: string,
  hash?: string | null
): Promise<boolean> {
  return bcrypt.compare(plain, hash && hash.length > 0 ? hash : DUMMY_HASH);
}
