import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * P2-3 regression suite — evaluateAlerts de-duplicates on tasks.last_alert_level,
 * but that is a read-then-write with the notification insert and the Telegram
 * push in between. Concurrent runs all saw last_alert_level = null and each one
 * independently notified every manager and posted to Telegram.
 *
 * Any member can trigger a run (POST .../alerts/evaluate) and every Files list
 * triggers one implicitly, so N parallel requests meant N copies of every alert
 * plus N full scans of the company's files and tasks.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { evaluateAlerts } = await import('@/lib/platform/alerts');

const COMPANY = 'company-a';

/** Counts how many times a full evaluation actually started. */
function stubDb() {
  let companyReads = 0;
  const stub = makeSupabaseStub((q) => {
    if (q.table === 'companies') {
      companyReads += 1;
      // alerts_enabled false → the run returns early, which is all we need:
      // the question is how many runs STARTED.
      return { data: { name_en: 'X', name_ar: 'س', alerts_enabled: false } };
    }
    return { data: null };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  return { reads: () => companyReads };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('evaluateAlerts — concurrent runs', () => {
  it('collapses parallel calls for one company into a single evaluation', async () => {
    const db = stubDb();

    await Promise.all([
      evaluateAlerts(COMPANY),
      evaluateAlerts(COMPANY),
      evaluateAlerts(COMPANY),
      evaluateAlerts(COMPANY),
      evaluateAlerts(COMPANY),
    ]);

    expect(db.reads()).toBe(1);
  });

  it('gives every caller the same completion, not a silent no-op', async () => {
    stubDb();

    // All five must resolve — joiners wait for the in-flight run rather than
    // returning early while it is still going.
    await expect(
      Promise.all(Array.from({ length: 5 }, () => evaluateAlerts(COMPANY)))
    ).resolves.toHaveLength(5);
  });

  it('does not collapse runs for DIFFERENT companies', async () => {
    const db = stubDb();

    await Promise.all([evaluateAlerts('company-a'), evaluateAlerts('company-b')]);

    expect(db.reads()).toBe(2);
  });

  it('allows a fresh evaluation once the previous one finishes', async () => {
    const db = stubDb();

    await evaluateAlerts(COMPANY);
    await evaluateAlerts(COMPANY);

    expect(db.reads()).toBe(2);
  });

  it('clears the in-flight entry even when the run throws', async () => {
    // A stuck entry would disable alerting for that company until redeploy.
    vi.mocked(getSupabaseAdmin).mockImplementationOnce(() => {
      throw new Error('supabase down');
    });
    await expect(evaluateAlerts(COMPANY)).rejects.toThrow('supabase down');

    const db = stubDb();
    await evaluateAlerts(COMPANY);

    expect(db.reads()).toBe(1);
  });

  it('ignores an empty company id', async () => {
    const db = stubDb();

    await evaluateAlerts('');

    expect(db.reads()).toBe(0);
  });
});
