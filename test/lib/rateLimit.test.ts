import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedStore,
  __resetForTests,
  accountLockStatus,
  acquireVerificationSlot,
  clearFailedAttempts,
  clientIp,
  rateLimit,
  recordFailedAttempt,
  verificationLoad,
} from '@/lib/rateLimit';

/**
 * P0-2 / P1-2 / P1-3 regression suite for the login throttling primitives.
 *
 * P0-2 — the per-IP limiter keyed off the LEFTMOST X-Forwarded-For entry, which
 *        is whatever the caller sent. Rotating it gave every request a fresh
 *        bucket, so an unauthenticated attacker could buy unlimited ~450ms
 *        bcrypt comparisons and stall the single Node process.
 * P1-2 — both tracking Maps grew forever; nothing was ever deleted except on a
 *        successful login.
 * P1-3 — lockout was keyed on the submitted identifier alone, so any stranger
 *        who knew an email could lock that account out indefinitely.
 */

const headers = (h: Record<string, string>) => new Headers(h);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Slot = Awaited<ReturnType<typeof acquireVerificationSlot>>;

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetForTests();
});

describe('clientIp — X-Forwarded-For spoofing', () => {
  it('ignores a client-supplied entry and takes the hop the edge appended', () => {
    // The attack: the caller prepends whatever they like. The edge then appends
    // the address it actually saw, so the real one is on the RIGHT.
    const ip = clientIp(
      headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })
    );

    expect(ip).toBe('203.0.113.9');
    expect(ip).not.toBe('1.2.3.4');
  });

  it('cannot be made to return a fresh value per request', () => {
    // Same real client, three different spoofed prefixes — all must collapse to
    // one bucket, otherwise the per-IP limit does not exist.
    const seen = new Set(
      ['9.9.9.9', 'not-an-ip', ''].map((spoof) =>
        clientIp(headers({ 'x-forwarded-for': `${spoof}, 203.0.113.9` }))
      )
    );

    expect(seen).toEqual(new Set(['203.0.113.9']));
  });

  it('is unchanged for an honest client behind one proxy', () => {
    // A browser sends no X-Forwarded-For; the edge writes a single entry. This
    // is the office-NAT case — the fix must not alter it.
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.7' }))).toBe(
      '198.51.100.7'
    );
  });

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientIp(headers({ 'x-real-ip': '198.51.100.8' }))).toBe('198.51.100.8');
    expect(clientIp(headers({}))).toBe('unknown');
  });
});

describe('rateLimit — sliding window', () => {
  it('allows exactly `limit` attempts, then refuses with a Retry-After', () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimit('k', 3, 60_000).allowed).toBe(true);
    }
    const blocked = rateLimit('k', 3, 60_000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    rateLimit('k', 1, 60_000);
    expect(rateLimit('k', 1, 60_000).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));

    expect(rateLimit('k', 1, 60_000).allowed).toBe(true);
  });

  it('keys buckets independently', () => {
    rateLimit('a', 1, 60_000);
    expect(rateLimit('a', 1, 60_000).allowed).toBe(false);
    expect(rateLimit('b', 1, 60_000).allowed).toBe(true);
  });
});

describe('BoundedStore — unbounded growth (P1-2)', () => {
  it('never exceeds its cap no matter how many unique keys arrive', () => {
    const store = new BoundedStore<{ expiresAt: number }>(100);
    const now = Date.now();

    for (let i = 0; i < 10_000; i++) {
      store.set(`key-${i}`, { expiresAt: now + 60_000 }, now);
    }

    expect(store.size).toBeLessThanOrEqual(100);
  });

  it('drops expired entries on sweep', () => {
    const store = new BoundedStore<{ expiresAt: number }>(100);
    store.set('old', { expiresAt: 1_000 }, 0);
    store.set('fresh', { expiresAt: 10_000 }, 0);

    store.sweep(5_000);

    expect(store.size).toBe(1);
    expect(store.get('fresh', 5_000)).toBeDefined();
  });

  it('does not let a flood of junk keys evict a protected record', () => {
    // Otherwise an attacker could clear the lockout on an account they are
    // brute-forcing simply by spamming unique identifiers.
    const now = Date.now();
    const store = new BoundedStore<{ expiresAt: number; locked: boolean }>(
      50,
      (v) => v.locked
    );
    store.set('victim', { expiresAt: now + 3_600_000, locked: true }, now);

    for (let i = 0; i < 5_000; i++) {
      store.set(`junk-${i}`, { expiresAt: now + 60_000, locked: false }, now);
    }

    expect(store.get('victim', now)).toBeDefined();
    expect(store.size).toBeLessThanOrEqual(50);
  });
});

describe('account lockout — weaponisation (P1-3)', () => {
  const VICTIM = 'yp@albaker.qa';
  const ATTACKER_IP = '203.0.113.66';
  const VICTIM_IP = '198.51.100.7';

  it('locks the SOURCE that keeps guessing wrong', () => {
    for (let i = 0; i < 6; i++) recordFailedAttempt(VICTIM, ATTACKER_IP);

    expect(accountLockStatus(VICTIM, ATTACKER_IP).locked).toBe(true);
  });

  it('does NOT lock the real owner out when a stranger attacks their account', () => {
    // The P1-3 exploit: ten wrong guesses against a known firm email used to
    // deny that person access to their own portal, with no recovery path.
    for (let i = 0; i < 10; i++) recordFailedAttempt(VICTIM, ATTACKER_IP);

    expect(accountLockStatus(VICTIM, VICTIM_IP).locked).toBe(false);
  });

  it('still catches a genuinely distributed attack via the global tier', () => {
    for (let i = 0; i < 50; i++) {
      recordFailedAttempt(VICTIM, `203.0.113.${i}`);
    }

    expect(accountLockStatus(VICTIM, '198.51.100.250').locked).toBe(true);
  });

  it('needs an order of magnitude more sources to reach the global tier', () => {
    // 5 failures from one source is enough to lock that source, but must be
    // nowhere near enough to lock the account for everyone.
    for (let i = 0; i < 5; i++) recordFailedAttempt(VICTIM, ATTACKER_IP);

    expect(accountLockStatus(VICTIM, ATTACKER_IP).locked).toBe(true);
    expect(accountLockStatus(VICTIM, VICTIM_IP).locked).toBe(false);
  });

  it('clears both tiers on a successful login', () => {
    for (let i = 0; i < 6; i++) recordFailedAttempt(VICTIM, ATTACKER_IP);
    clearFailedAttempts(VICTIM, ATTACKER_IP);

    expect(accountLockStatus(VICTIM, ATTACKER_IP).locked).toBe(false);
  });

  it('reports a positive Retry-After while locked', () => {
    for (let i = 0; i < 6; i++) recordFailedAttempt(VICTIM, ATTACKER_IP);

    expect(accountLockStatus(VICTIM, ATTACKER_IP).retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('acquireVerificationSlot — the global CPU bound (P0-2)', () => {
  it('caps how many verifications run at once', async () => {
    const { maxConcurrent } = verificationLoad();
    const held: Slot[] = [];
    for (let i = 0; i < maxConcurrent; i++) {
      held.push(await acquireVerificationSlot());
    }

    expect(verificationLoad().active).toBe(maxConcurrent);

    let admitted = false;
    const pending = acquireVerificationSlot().then((s) => {
      admitted = true;
      return s;
    });
    await flush();

    // The surplus caller waits rather than starting another bcrypt.
    expect(admitted).toBe(false);
    expect(verificationLoad().queued).toBe(1);

    held[0].release();
    const slot = await pending;
    expect(slot.ok).toBe(true);

    slot.release();
    held.slice(1).forEach((s) => s.release());
  });

  it('sheds load instead of queueing without limit', async () => {
    const { maxConcurrent, maxQueued } = verificationLoad();
    const held: Slot[] = [];
    for (let i = 0; i < maxConcurrent; i++) {
      held.push(await acquireVerificationSlot());
    }
    const queued: Promise<Slot>[] = [];
    for (let i = 0; i < maxQueued; i++) queued.push(acquireVerificationSlot());
    await flush();

    // This is the request that would otherwise have bought ~450ms of CPU.
    const shed = await acquireVerificationSlot();

    expect(shed.ok).toBe(false);
    expect(verificationLoad().queued).toBe(maxQueued);

    held.forEach((s) => s.release());
    for (const p of queued) (await p).release();
  });

  it('admits exactly one waiter per release', async () => {
    const { maxConcurrent } = verificationLoad();
    const held: Slot[] = [];
    for (let i = 0; i < maxConcurrent; i++) {
      held.push(await acquireVerificationSlot());
    }
    const a = acquireVerificationSlot();
    const b = acquireVerificationSlot();
    await flush();
    expect(verificationLoad().queued).toBe(2);

    held[0].release();
    await flush();
    expect(verificationLoad().queued).toBe(1);

    held[1].release();
    await flush();
    expect(verificationLoad().queued).toBe(0);

    (await a).release();
    (await b).release();
  });

  it('ignores a double release so the cap cannot drift upward', async () => {
    const slot = await acquireVerificationSlot();
    slot.release();
    slot.release();

    expect(verificationLoad().active).toBe(0);
  });
});
