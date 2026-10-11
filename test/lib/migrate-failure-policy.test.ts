import { describe, expect, it } from 'vitest';
import { exitCodeFor, isStrict } from '../../scripts/migrate';

/**
 * The deploy policy, pinned.
 *
 * railway.json chains this as `migrate && start`, so THIS EXIT CODE decides
 * whether the web server boots. It used to be 1 on any failure, which meant a
 * migration that could not run — including one that merely could not reach the
 * database — took the entire site down rather than leaving the schema one
 * migration behind. The app's data layer already tolerates a missing table or
 * column (the "DEPLOY SAFETY" guards in lib/platform/), because that is its
 * normal state during every deploy.
 *
 * If someone ever "tidies" exitCodeFor back into `return result.ok ? 0 : 1`,
 * these fail.
 */

describe('isStrict', () => {
  it.each(['1', 'true', 'TRUE', 'yes', ' 1 '])('treats %j as strict', (v) => {
    expect(isStrict({ MIGRATE_STRICT: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each(['', '0', 'false', 'no', 'off'])('treats %j as not strict', (v) => {
    expect(isStrict({ MIGRATE_STRICT: v } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('defaults to NOT strict when the variable is absent', () => {
    expect(isStrict({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('exitCodeFor', () => {
  const loose = {} as unknown as NodeJS.ProcessEnv;
  const strict = { MIGRATE_STRICT: '1' } as unknown as NodeJS.ProcessEnv;

  it('exits 0 on success', () => {
    expect(exitCodeFor({ ok: true, ran: 3 }, loose)).toBe(0);
  });

  it('exits 0 on FAILURE, so `migrate && start` still starts the server', () => {
    // The whole point of the change: a broken or unreachable database must not
    // be able to take the site down.
    expect(exitCodeFor({ ok: false, ran: 0 }, loose)).toBe(0);
  });

  it('exits 0 on a PARTIAL run too', () => {
    expect(exitCodeFor({ ok: false, ran: 2 }, loose)).toBe(0);
  });

  it('exits 1 on failure under MIGRATE_STRICT, restoring the old behaviour', () => {
    expect(exitCodeFor({ ok: false, ran: 0 }, strict)).toBe(1);
  });

  it('still exits 0 on SUCCESS under MIGRATE_STRICT', () => {
    // Strict must gate failures only — never turn a clean run into an outage.
    expect(exitCodeFor({ ok: true, ran: 1 }, strict)).toBe(0);
  });
});
