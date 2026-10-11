import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingIntakeParts, isCustomerComplete } from '@/lib/platform/paylaterIntake';

/**
 * A CLIENT COMPONENT MUST NOT IMPORT A VALUE FROM A `server-only` MODULE.
 *
 * `lib/platform/paylater.ts` starts with `import 'server-only'`, which throws at
 * BUILD time if it is pulled into a client bundle. TypeScript cannot see that —
 * `npx tsc --noEmit` passes cleanly — so the only signal is the page failing to
 * render, which is exactly how this was found: a blank screen and a webpack
 * error, after a green typecheck.
 *
 * `import type` is fine: types are erased and never reach the bundle. It is
 * VALUE imports that break, so that is what this checks.
 */
const CLIENT_DIR = join(process.cwd(), 'components/collections');
const CLIENT_FILES = readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.tsx'));

/** Modules that carry `import 'server-only'`. */
const SERVER_ONLY = readdirSync(join(process.cwd(), 'lib/platform'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) =>
    readFileSync(join(process.cwd(), 'lib/platform', f), 'utf8').includes(
      "import 'server-only'"
    )
  )
  .map((f) => f.replace(/\.ts$/, ''));

describe('the PayLater client/server boundary', () => {
  it('found the server-only modules it is meant to police', () => {
    expect(SERVER_ONLY).toContain('paylater');
  });

  it('every client component is marked "use client"', () => {
    for (const f of CLIENT_FILES) {
      expect(readFileSync(join(CLIENT_DIR, f), 'utf8').startsWith("'use client'"), f).toBe(
        true
      );
    }
  });

  it('no client component imports a VALUE from a server-only module', () => {
    for (const f of CLIENT_FILES) {
      const src = readFileSync(join(CLIENT_DIR, f), 'utf8');
      for (const mod of SERVER_ONLY) {
        // Matches `import { x } from '.../mod'` but not `import type { x } ...`
        const valueImport = new RegExp(
          `import\\s+(?!type\\b)[^;]*from\\s+['"][^'"]*/${mod}['"]`
        );
        const hit = src.match(valueImport);
        // An `import { type X }` inline-type form is also safe.
        const inlineTypeOnly =
          hit && /import\s*\{\s*(type\s+[^,}]+)(,\s*type\s+[^,}]+)*\s*\}/.test(hit[0]);
        expect(
          !hit || inlineTypeOnly,
          `${f} imports a value from server-only '${mod}': ${hit?.[0]}`
        ).toBe(true);
      }
    }
  });

  it('the shared intake rules carry no server-only marker', () => {
    const src = readFileSync(join(process.cwd(), 'lib/platform/paylaterIntake.ts'), 'utf8');
    expect(src).not.toContain("import 'server-only'");
  });
});

/**
 * The rules themselves. All 560 imported files score 0/4 — they came from the
 * Progress Report, which carries none of the intake detail — so the UI shows
 * the fraction rather than one verdict repeated 560 times.
 */
describe('missingIntakeParts', () => {
  const none = { gender: null, reportDate: null, paylaterRegDate: null, orderCount: 0 };

  it('names all four when nothing has been captured — the imported case', () => {
    expect(missingIntakeParts(none)).toEqual([
      'gender',
      'reportDate',
      'regDate',
      'orders',
    ]);
  });

  it('shrinks as each part arrives', () => {
    expect(missingIntakeParts({ ...none, gender: 'male' })).toEqual([
      'reportDate',
      'regDate',
      'orders',
    ]);
    expect(
      missingIntakeParts({
        gender: 'male',
        reportDate: '2026-08-05',
        paylaterRegDate: '2025-04-20',
        orderCount: 2,
      })
    ).toEqual([]);
  });

  it('agrees with isCustomerComplete', () => {
    const order = {
      orderRef: 'SQ1',
      orderDate: '2026-01-01',
      storeAr: 'متجر',
      amount: 100,
      instalment: 25,
      paidCount: 2,
      paidTotal: 50,
      remaining: 50,
    };
    const full = {
      gender: 'male',
      reportDate: '2026-08-05',
      paylaterRegDate: '2025-04-20',
      orders: [order],
    };
    expect(isCustomerComplete(full)).toBe(true);
    expect(isCustomerComplete({ ...full, orders: [] })).toBe(false);
    // Present but half-filled is still not complete.
    expect(
      isCustomerComplete({ ...full, orders: [{ ...order, remaining: null }] })
    ).toBe(false);
  });
});
