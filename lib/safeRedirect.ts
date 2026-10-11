/**
 * Validate a caller-supplied post-login destination.
 *
 * `?next=` reaches the login page from middleware (which sets it to the
 * protected pathname the user was heading for) but is trivially settable by
 * anyone crafting a link. The only acceptable value is a SAME-SITE ABSOLUTE
 * PATH.
 *
 * `startsWith('/')` alone is not that test, which is what this used to be:
 *   '//evil.com'   → protocol-relative; the browser resolves it to another origin
 *   '/\evil.com'   → same, browsers normalise the backslash to '/'
 * Either turns the login page into an open redirect — a credible phishing
 * primitive, since the victim really did just authenticate on the real domain
 * before being handed to the attacker's.
 *
 * Returns the path when it is safe, otherwise undefined so the caller falls back
 * to its own default.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeNextPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0) return undefined;
  // Must be an absolute path…
  if (!raw.startsWith('/')) return undefined;
  // …and not a protocol-relative URL in disguise.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return undefined;
  // Control characters (a stray newline or tab) have no place in a path and can
  // confuse downstream parsers.
  if (CONTROL_CHARS.test(raw)) return undefined;
  return raw;
}
