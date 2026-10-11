/**
 * Login throttling primitives.
 *
 * FOUR independent controls, layered deliberately:
 *
 *  1. rateLimit()              — generic per-key sliding window (used per-IP).
 *  2. acquireVerificationSlot()— a GLOBAL cap on how many password
 *                                verifications may run at once. This is the
 *                                only control that does not depend on
 *                                correctly identifying the caller, so it is the
 *                                one that actually bounds CPU.
 *  3. per-SOURCE account lockout — (account, ip) failures, escalating.
 *  4. per-ACCOUNT global lockout — a much higher threshold across all sources,
 *                                so distributed brute force is still caught
 *                                without letting one stranger lock a known
 *                                account at will.
 *
 * WHY (2) EXISTS. bcrypt at cost 12 costs ~450ms of CPU per comparison, and the
 * login route deliberately hashes even for unknown accounts (timing-safe decoy,
 * see lib/password.ts). Controls 1/3/4 are all keyed on something the client
 * influences — the IP header or the submitted identifier — so an attacker who
 * varies both walks straight past them. Rotating identifiers also means the
 * per-account counters never trip. The global slot cap has no key at all: past
 * the limit, work is REFUSED rather than queued indefinitely, so surplus
 * requests cost ~0 CPU instead of ~450ms each. That is what turns a
 * single-laptop outage into a bounded slowdown.
 *
 * MEMORY. Both stores are bounded (BoundedStore below): entries carry an expiry,
 * are swept periodically, and the map is hard-capped. An attacker sending
 * millions of unique identifiers can no longer grow the heap without limit.
 * Eviction deliberately prefers expired-then-unlocked entries so flooding
 * garbage keys cannot push an active lockout out of the store.
 *
 * SCOPE LIMIT — state is in-memory and PER-INSTANCE. It resets on redeploy and
 * is not shared across replicas. Control (2) still bounds CPU correctly on every
 * instance independently (it is a per-process resource), but controls 1/3/4
 * become per-replica. For multi-replica strictness back them with a shared store
 * (a Supabase table with an atomic increment RPC, or Redis).
 */

// ---------------------------------------------------------------------------
// Bounded, self-expiring key store
// ---------------------------------------------------------------------------

interface Expiring {
  /** Epoch ms after which this record carries no meaning. */
  expiresAt: number;
}

/** How many keys either store may hold before it starts evicting. */
const MAX_TRACKED_KEYS = 20_000;
/** Sweep expired entries every N writes (amortised, no timers). */
const SWEEP_EVERY_WRITES = 512;
/** How far to look for an evictable entry before forcing the oldest out. */
const EVICTION_SCAN = 64;

/**
 * A Map that cannot grow without bound.
 *
 * Insertion order is used as the eviction order (JS Maps preserve it), but
 * eviction is not blindly "oldest wins": it prefers expired entries, then
 * unprotected ones. Without that, an attacker could flood the store with
 * throwaway keys purely to evict the lockout record of an account they are
 * attacking.
 */
export class BoundedStore<V extends Expiring> {
  private readonly map = new Map<string, V>();
  private writesSinceSweep = 0;

  constructor(
    private readonly maxKeys: number = MAX_TRACKED_KEYS,
    /** Records for which eviction should be a last resort (e.g. active locks). */
    private readonly isProtected: (value: V, now: number) => boolean = () => false
  ) {}

  get(key: string, now: number): V | undefined {
    const value = this.map.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return value;
  }

  set(key: string, value: V, now: number): void {
    this.maybeSweep(now);
    // Re-insert so eviction order tracks least-recently-written.
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxKeys) this.evictOne(now);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** Test seam: force the amortised sweep to run now. */
  sweep(now: number): void {
    for (const [key, value] of this.map) {
      if (value.expiresAt <= now) this.map.delete(key);
    }
    this.writesSinceSweep = 0;
  }

  private maybeSweep(now: number): void {
    if (++this.writesSinceSweep < SWEEP_EVERY_WRITES) return;
    this.sweep(now);
  }

  private evictOne(now: number): void {
    let fallback: string | undefined;
    let scanned = 0;
    for (const [key, value] of this.map) {
      if (fallback === undefined) fallback = key;
      if (value.expiresAt <= now || !this.isProtected(value, now)) {
        this.map.delete(key);
        return;
      }
      if (++scanned >= EVICTION_SCAN) break;
    }
    // Everything we looked at is an active lock — drop the oldest regardless so
    // the store still respects its cap.
    if (fallback !== undefined) this.map.delete(fallback);
  }
}

// ---------------------------------------------------------------------------
// 1. Generic sliding-window limiter
// ---------------------------------------------------------------------------

type Bucket = Expiring & { count: number };

const buckets = new BoundedStore<Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * @param key       unique client key (e.g. `login:ip:<ip>`)
 * @param limit     max attempts allowed within the window
 * @param windowMs  window length in milliseconds
 */
export function rateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key, now);

  if (!existing) {
    buckets.set(key, { count: 1, expiresAt: now + windowMs }, now);
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: limit - existing.count,
    retryAfterSeconds: 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Global verification concurrency cap  (the actual CPU bound)
// ---------------------------------------------------------------------------

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Concurrent bcrypt comparisons. Small on purpose: bcryptjs is pure JS and runs
 * on the event loop, so "concurrent" here means "sharing one core". Two keeps
 * the process responsive while still allowing ~4 logins/second sustained — far
 * beyond what a firm of this size generates.
 */
const MAX_CONCURRENT = intFromEnv('LOGIN_MAX_CONCURRENT_VERIFICATIONS', 2);
/**
 * How many callers may wait for a slot. Bounds the worst-case queue wait
 * (MAX_QUEUED / MAX_CONCURRENT × ~450ms ≈ 4.5s at the defaults) and, past that,
 * sheds load instantly instead of accepting unbounded work.
 */
const MAX_QUEUED = intFromEnv('LOGIN_MAX_QUEUED_VERIFICATIONS', 20);

let active = 0;
const waiting: Array<() => void> = [];

export interface VerificationSlot {
  ok: boolean;
  /** Release the slot. Safe to call once; further calls are ignored. */
  release: () => void;
}

/**
 * Reserve capacity to run one password verification.
 *
 * Acquire this BEFORE any database lookup, so a shed request costs neither CPU
 * nor a round trip. `{ ok: false }` means the process is saturated and the
 * caller should return 503 immediately.
 */
export async function acquireVerificationSlot(): Promise<VerificationSlot> {
  if (active >= MAX_CONCURRENT && waiting.length >= MAX_QUEUED) {
    return { ok: false, release: () => {} };
  }

  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  active += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    },
  };
}

/** Test/diagnostic seam. */
export function verificationLoad(): {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
} {
  return {
    active,
    queued: waiting.length,
    maxConcurrent: MAX_CONCURRENT,
    maxQueued: MAX_QUEUED,
  };
}

// ---------------------------------------------------------------------------
// 3 + 4. Account lockout, two tiers
// ---------------------------------------------------------------------------

type FailRecord = Expiring & { fails: number; firstAt: number; lockedUntil: number };

/** Per-source tier: 5 wrong guesses from ONE source locks that source. */
const SOURCE_MAX_FAILS = 5;
/**
 * Global tier: how many failures an account may accumulate across ALL sources
 * before the account itself locks. Set high on purpose — the low per-source
 * threshold is what stops brute force, while this only catches a genuinely
 * distributed attack. Keeping it well above SOURCE_MAX_FAILS is what stops a
 * stranger from locking a known account (e.g. the admin's email) at will, which
 * a single shared counter would allow with five requests.
 */
const ACCOUNT_MAX_FAILS = 50;

const FAIL_WINDOW_MS = 15 * 60_000; // 15 min rolling window
const BASE_LOCK_MS = 15 * 60_000; // 15 min base lockout, escalating

const failures = new BoundedStore<FailRecord>(
  MAX_TRACKED_KEYS,
  (record, now) => record.lockedUntil > now
);

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

const UNLOCKED: LockStatus = { locked: false, retryAfterSeconds: 0 };

function statusOf(key: string, now: number): LockStatus {
  const record = failures.get(key, now);
  if (record && record.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)),
    };
  }
  return UNLOCKED;
}

function sourceKey(identifier: string, ip: string): string {
  return `login:acct:${identifier}|ip:${ip}`;
}

function accountKey(identifier: string): string {
  return `login:acct:${identifier}`;
}

/**
 * Is this login attempt currently locked out?
 *
 * Checks both tiers: the (account, source) pair, then the account globally.
 * `ip` should come from clientIp() below.
 */
export function accountLockStatus(identifier: string, ip: string): LockStatus {
  const now = Date.now();
  const bySource = statusOf(sourceKey(identifier, ip), now);
  if (bySource.locked) return bySource;
  return statusOf(accountKey(identifier), now);
}

function bump(key: string, threshold: number, now: number): void {
  const record = failures.get(key, now);

  if (!record || now - record.firstAt > FAIL_WINDOW_MS) {
    failures.set(
      key,
      { fails: 1, firstAt: now, lockedUntil: 0, expiresAt: now + FAIL_WINDOW_MS },
      now
    );
    return;
  }

  record.fails += 1;
  if (record.fails >= threshold) {
    // Exponential backoff: 15m, 30m, 60m, … capped at 8× (2h).
    const factor = Math.min(8, 2 ** (record.fails - threshold));
    record.lockedUntil = now + BASE_LOCK_MS * factor;
    record.expiresAt = record.lockedUntil;
  }
  failures.set(key, record, now);
}

/** Record a failed login attempt against both tiers. */
export function recordFailedAttempt(identifier: string, ip: string): void {
  const now = Date.now();
  bump(sourceKey(identifier, ip), SOURCE_MAX_FAILS, now);
  bump(accountKey(identifier), ACCOUNT_MAX_FAILS, now);
}

/** Clear an account's failure records after a successful login. */
export function clearFailedAttempts(identifier: string, ip: string): void {
  failures.delete(sourceKey(identifier, ip));
  failures.delete(accountKey(identifier));
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

/**
 * How many proxy hops in front of this app are trusted to have appended to
 * X-Forwarded-For. Railway's edge terminates TLS and appends exactly one entry,
 * so 1 is correct for the current deployment. Raise it only if you add another
 * trusted proxy (e.g. Cloudflare in front of Railway).
 */
const TRUSTED_PROXY_HOPS = intFromEnv('TRUSTED_PROXY_HOPS', 1);

/**
 * The client IP, read from the RIGHT-hand side of X-Forwarded-For.
 *
 * X-Forwarded-For is `client, proxy1, proxy2, …`: each proxy APPENDS the address
 * it received the connection from. Anything a client sends itself can therefore
 * only ever appear to the LEFT of what our own infrastructure appended.
 *
 * Reading the leftmost value — the obvious-looking choice, and what this used to
 * do — means the caller picks their own rate-limit bucket: `X-Forwarded-For:
 * <random>` on every request gives every request a fresh bucket and the per-IP
 * limit stops existing. Counting TRUSTED_PROXY_HOPS from the right instead
 * selects the entry our edge wrote, which a client cannot forge.
 *
 * Honest clients are unaffected: a browser sends no X-Forwarded-For, the edge
 * writes a single entry, and both the old and new logic select it.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    if (hops.length > 0) {
      const index = Math.max(0, hops.length - TRUSTED_PROXY_HOPS);
      return hops[index];
    }
  }
  return headers.get('x-real-ip') || 'unknown';
}

// ---------------------------------------------------------------------------
// Test-only reset. Module state is process-global; tests need a clean slate.
// ---------------------------------------------------------------------------

export function __resetForTests(): void {
  buckets.sweep(Number.POSITIVE_INFINITY);
  failures.sweep(Number.POSITIVE_INFINITY);
  active = 0;
  waiting.length = 0;
}
