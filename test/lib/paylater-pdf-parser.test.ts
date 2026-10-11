import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CUSTOMER REPORT PARSER, checked against ground truth.
 *
 * The spec left one question open: can the orders be read without a model? The
 * answer is yes — every report carries a text layer — and this is the test that
 * keeps it answered.
 *
 * GROUND TRUTH IS REAL, NOT INVENTED. Three of the four customers seeded into
 * the v2 prototype appear in Batch 7, so their correct values were known before
 * this parser existed. If the parser drifts, these fail.
 *
 * THE PDFS ARE NOT IN GIT — they carry real names, QIDs and debts. When they
 * are absent the suite skips rather than fails, so a checkout without them is
 * still green; `npm test` on the firm's machine runs the real thing.
 */
const BATCH7 =
  '/Users/zawyh/Desktop/albaker-portal-local/PayLater Portal/PAYLATER BATCH 7';
const HAVE_PDFS = existsSync(BATCH7);

/**
 * Imported directly. `server-only` is already aliased to a stub in
 * vitest.config.ts, so no copy of the module is needed — an earlier version of
 * this test wrote a stripped copy into the project root and deleted it
 * asynchronously, which raced with the other test files running in parallel and
 * made three unrelated API tests fail with a 500.
 */
async function loadParser() {
  return import('@/lib/platform/paylaterPdf');
}

const find = (needle: string): string | null => {
  try {
    const out = execSync(
      `find "${BATCH7}" -path "*${needle}*" -name customer_form.pdf`,
      { encoding: 'utf8' }
    ).trim();
    return out.split('\n')[0] || null;
  } catch {
    return null;
  }
};

describe.skipIf(!HAVE_PDFS)('parseCustomerReport — against v2 ground truth', () => {
  it('reads SULIMAN KHOGALI BABIKER exactly as the prototype recorded him', async () => {
    const { parseCustomerReport } = await loadParser();
    const f = find('25684000635');
    expect(f).toBeTruthy();
    const r = await parseCustomerReport(new Uint8Array(readFileSync(f!)));

    expect(r.qid).toBe('25684000635');
    expect(r.nameEn).toBe('SULIMAN KHOGALI BABIKER');
    expect(r.nationality).toBe('America');
    expect(r.email).toBe('suliman@sakint.com');
    expect(r.paylaterRegDate).toBe('2025-04-20');
    expect(r.reportDate).toBe('2026-08-05');
    expect(r.debtTotal).toBe(4375);
    // The Excel's INSTALLMENT column for this customer is 5.
    expect(r.pendingInstalments).toBe(5);

    const a = r.orders.find((o) => o.orderRef === 'SQ1767219705137871');
    expect(a, 'order not found').toBeDefined();
    if (!a) return;
    expect(a.amount).toBe(1250);
    expect(a.instalment).toBe(312.5);
    // Only «تم الدفع بنجاح» / "Payment success" counts.
    expect(a.paidCount).toBe(2);
    // Copied from the report, never recomputed.
    expect(a.paidTotal).toBe(625);
    expect(a.remaining).toBe(625);
    // The Arabic merchant name is taken verbatim, never translated.
    expect(a.storeAr).toBe('كينيتيك يفينتس');
    expect(a.storeEn).toBe('Kinetic events');
  });

  it('reads a customer whose instalment rows carry one fewer column', async () => {
    // MUNA's rows read "…761095 1 250.00" where SULIMAN's read
    // "…143773 4 1 312.50". A fixed-arity row pattern silently returned zero
    // instalments for her, which looked like a customer who had paid nothing.
    const { parseCustomerReport } = await loadParser();
    const f = find('27163401448');
    expect(f).toBeTruthy();
    const r = await parseCustomerReport(new Uint8Array(readFileSync(f!)));
    expect(r.debtTotal).toBe(3750);
    expect(r.pendingInstalments).toBe(6);
    const a = r.orders.find((o) => o.orderRef === 'SQ1741984674634338');
    expect(a, 'order not found').toBeDefined();
    if (!a) return;
    expect(a.amount).toBe(4000);
    expect(a.paidCount).toBe(1);
    expect(a.remaining).toBe(3000);
    expect(a.storeAr).toBe('ستارلينك');
  });

  it('reads orders whose id is not SQ', async () => {
    // Nine customers' orders are all "PL…". A parser that only knew "SQ"
    // reported them as having no orders at all.
    const { parseCustomerReport } = await loadParser();
    const f = find('28805016186');
    expect(f).toBeTruthy();
    const r = await parseCustomerReport(new Uint8Array(readFileSync(f!)));
    expect(r.orders.length).toBeGreaterThan(0);
    expect(r.orders.every((o) => /^[A-Z]{2,4}\d+$/.test(o.orderRef))).toBe(true);
    expect(r.orders.some((o) => o.orderRef.startsWith('PL'))).toBe(true);
  });

  it('reads every report in the batch, with each order internally consistent', async () => {
    const { parseCustomerReport } = await loadParser();
    const files = execSync(`find "${BATCH7}" -name customer_form.pdf`, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(files.length).toBeGreaterThan(50);

    let orders = 0;
    for (const f of files) {
      const r = await parseCustomerReport(new Uint8Array(readFileSync(f)));
      expect(r.qid, f).toBeTruthy();
      expect(r.reportDate, f).toBeTruthy();
      expect(r.paylaterRegDate, f).toBeTruthy();
      for (const o of r.orders) {
        orders++;
        expect(o.amount, `${f} ${o.orderRef}`).not.toBeNull();
        expect(o.instalment, `${f} ${o.orderRef}`).not.toBeNull();
        expect(o.storeAr, `${f} ${o.orderRef}`).toBeTruthy();
        expect(o.orderDate, `${f} ${o.orderRef}`).toBeTruthy();
        // The report's own arithmetic must hold, or we have misread a column.
        expect(
          Math.abs((o.paidTotal ?? 0) + (o.remaining ?? 0) - (o.amount ?? 0)),
          `${f} ${o.orderRef}`
        ).toBeLessThan(0.05);
      }
    }
    expect(orders).toBeGreaterThan(200);
  }, 120_000);
});

describe('the extract route needs no API key', () => {
  it('does not read ANTHROPIC_API_KEY anywhere', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/paylater/extract/route.ts'),
      'utf8'
    );
    // The doc comment may mention it; the code must not use it.
    expect(route).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    expect(route).not.toContain('api.anthropic.com');
  });
});
