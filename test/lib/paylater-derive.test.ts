import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFlags,
  compensation,
  delayMonths,
  delayWord,
  documentCount,
  isArabicNationality,
  nationalityAdjective,
  noticeDateInWindow,
  normaliseNationality,
} from '@/lib/platform/paylaterDerive';

/**
 * THE DERIVED FIELDS, taken from the v2 prototype rather than invented.
 *
 * Each of these feeds a document that goes to a court, so "close enough" is not
 * a category here. The values below are the prototype's, not a reimagining.
 */
describe('nationality', () => {
  it('gives a GENDERED adjective — it is printed in the notice', () => {
    expect(nationalityAdjective('Sudan', 'male')).toBe('سوداني');
    expect(nationalityAdjective('Sudan', 'female')).toBe('سودانية');
    expect(nationalityAdjective('India', 'male')).toBe('هندي');
    expect(nationalityAdjective('India', 'female')).toBe('هندية');
  });

  it('matches case-insensitively — the import produced both Qatar and QATAR', () => {
    expect(normaliseNationality('QATAR')).toBe('Qatar');
    expect(normaliseNationality('qatar')).toBe('Qatar');
    expect(nationalityAdjective('SUDAN', 'female')).toBe('سودانية');
  });

  it('resolves the prototype’s aliases', () => {
    expect(normaliseNationality('USA')).toBe('America');
    expect(normaliseNationality('srilanka')).toBe('Sri Lanka');
    expect(normaliseNationality('KSA')).toBe('Saudi Arabia');
  });

  it('returns nothing rather than guessing for an unknown country', () => {
    expect(normaliseNationality('Atlantis')).toBeNull();
    expect(nationalityAdjective('Atlantis', 'male')).toBe('');
    expect(documentCount('Atlantis')).toBeNull();
  });
});

describe('the notice shape follows the nationality', () => {
  it('an Arabic-speaking nationality gets 7 documents, everyone else 8', () => {
    // The eighth document is the translation.
    expect(isArabicNationality('Qatar')).toBe(true);
    expect(documentCount('Qatar')).toBe(7);
    expect(isArabicNationality('India')).toBe(false);
    expect(documentCount('India')).toBe(8);
  });
});

describe('compensation is a tier, not a percentage', () => {
  it('claims 20,000 under 10,000 and 50,000 from 10,000 up', () => {
    expect(compensation(4375)).toBe(20000);
    expect(compensation(9999.99)).toBe(20000);
    expect(compensation(10000)).toBe(50000);
    expect(compensation(25000)).toBe(50000);
  });

  it('has nothing to claim with no total', () => {
    expect(compensation(null)).toBeNull();
    expect(compensation(0)).toBeNull();
  });
});

describe('the delay runs from the NEWEST order, once its paid instalments end', () => {
  const order = (orderDate: string, paidCount: number) => ({
    orderDate, paidCount, amount: null, paidTotal: null,
    remaining: null, orderRef: null, storeAr: null, instalment: null,
  });

  it('adds the paid instalments to the newest order date', () => {
    // 2026-01-01 + 2 paid = 2026-03-01 → 2026-08-23 is five months.
    expect(delayMonths([order('2026-01-01', 2)], '2026-08-23').months).toBe(5);
    expect(delayMonths([order('2026-01-01', 0)], '2026-08-23').months).toBe(7);
  });

  it('uses the NEWEST order, not the oldest', () => {
    // Measuring from the 2024 order would overstate the delay by a year and a
    // half on a customer who bought again recently.
    const orders = [order('2024-01-01', 0), order('2026-01-01', 0)];
    expect(delayMonths(orders, '2026-08-23').months).toBe(7);
  });

  it('flags two orders tying for the newest date', () => {
    const orders = [order('2026-01-01', 0), order('2026-01-01', 0)];
    expect(delayMonths(orders, '2026-08-23').tie).toBe(true);
    expect(delayMonths([order('2026-01-01', 0)], '2026-08-23').tie).toBe(false);
  });

  it('says nothing without an order date or a notice date', () => {
    expect(delayMonths([], '2026-08-23').months).toBeNull();
    expect(delayMonths([order('2026-01-01', 0)], null).months).toBeNull();
  });
});

describe('the delay as the memo writes it', () => {
  it('uses the Arabic dual and the spelled-out numbers', () => {
    expect(delayWord(1)).toBe('(شهر)');
    expect(delayWord(2)).toBe('(شهرين)');
    expect(delayWord(5)).toBe('(خمسة أشهر)');
    expect(delayWord(10)).toBe('(عشرة أشهر)');
    expect(delayWord(14)).toBe('(14 أشهر)');
    expect(delayWord(0)).toBe('—');
    expect(delayWord(null)).toBe('—');
  });
});

describe('the notice date belongs in the last 10 days of its month', () => {
  it('accepts the last ten days and warns before them', () => {
    expect(noticeDateInWindow('2026-08-23')).toBe(true); // Aug has 31
    expect(noticeDateInWindow('2026-08-22')).toBe(true);
    expect(noticeDateInWindow('2026-08-21')).toBe(false);
    expect(noticeDateInWindow('2026-02-19')).toBe(true); // Feb 2026 has 28
    expect(noticeDateInWindow(null)).toBe(true);
  });
});

/** The flags panel is what decides whether a file may be saved at all. */
describe('buildFlags', () => {
  const t = (k: string, v?: Record<string, string>) =>
    v ? `${k}:${Object.values(v).join(',')}` : k;
  const base = {
    values: {
      nameAr: 'أحمد', nameEn: 'AHMED', qid: '29900000003',
      nationality: 'Sudan', paylaterRegDate: '2025-04-20',
      reportDate: '2026-08-05', debtTotal: '4375', noticePlanned: '2026-08-23',
    },
    gender: 'male', qidName: '', nameEn: 'AHMED',
    debtTotal: 4375, noticePlanned: '2026-08-23',
    orders: [{
      orderDate: '2026-01-01', paidCount: 2, amount: 4375,
      paidTotal: 0, remaining: 4375, orderRef: 'SQ1', storeAr: 'متجر',
      instalment: 100,
    }],
    tie: false,
    label: (f: string) => f,
    t,
  };

  it('a complete file blocks nothing', () => {
    const { flags, blocking } = buildFlags(base);
    expect(blocking).toEqual([]);
    expect(flags.map((f) => f.kind)).toContain('ok');
  });

  it('blocks on a QID that is not exactly 11 digits', () => {
    for (const bad of ['123', '299000000030', '29900000a03']) {
      const { blocking } = buildFlags({
        ...base,
        values: { ...base.values, qid: bad },
      });
      expect(blocking, bad).toContain('qid');
    }
  });

  it('blocks on an unconfirmed gender — it picks the memo template', () => {
    expect(buildFlags({ ...base, gender: '' }).blocking).toContain('gender');
  });

  it('blocks on no orders, and on an order with a hole in it', () => {
    expect(buildFlags({ ...base, orders: [] }).blocking).toContain('orders');
    expect(
      buildFlags({
        ...base,
        orders: [{ ...base.orders[0], paidTotal: null }],
      }).blocking
    ).toContain('orders');
  });

  it('blocks a NEW file on a duplicate QID, and names the batch holding it', () => {
    const { flags, blocking } = buildFlags({
      ...base,
      duplicateInBatch: 'A10',
      isNewFile: true,
    });
    expect(blocking).toContain('qid');
    expect(flags.some((f) => f.kind === 'err' && f.text.includes('A10'))).toBe(true);
  });

  it('only WARNS an existing file, so a repeat customer can still be corrected', () => {
    // Blocking here would freeze every repeat customer's record: nobody could
    // fix a name or confirm a gender on a file whose QID appears elsewhere.
    const { flags, blocking } = buildFlags({ ...base, duplicateInBatch: 'A10' });
    expect(blocking).not.toContain('qid');
    expect(flags.some((f) => f.kind === 'warn' && f.text.includes('A10'))).toBe(true);
  });

  it('blocks on each missing required field', () => {
    const { blocking } = buildFlags({
      ...base,
      values: { ...base.values, nameAr: '', reportDate: '' },
    });
    expect(blocking).toContain('nameAr');
    expect(blocking).toContain('reportDate');
  });

  it('warns without blocking when the orders do not sum to the total', () => {
    const { flags, blocking } = buildFlags({
      ...base,
      orders: [{ ...base.orders[0], remaining: 999 }],
    });
    expect(blocking).toEqual([]);
    expect(flags.some((f) => f.kind === 'warn')).toBe(true);
  });

  it('lists errors before warnings', () => {
    const { flags } = buildFlags({ ...base, gender: '', tie: true });
    const kinds = flags.map((f) => f.kind);
    expect(kinds.indexOf('err')).toBeLessThan(kinds.lastIndexOf('warn'));
  });
});

/**
 * A component declared inside another component is a new type on every render,
 * so React remounts the subtree and the field being typed into loses focus
 * after one character. That shipped briefly and made the form unusable.
 */
describe('the form does not redefine its field components on every render', () => {
  const src = readFileSync(
    join(process.cwd(), 'components/collections/CustomerForm.tsx'),
    'utf8'
  );
  const componentStart = src.indexOf('export default function CustomerForm');

  it('declares Field, Section and Chip at module level', () => {
    for (const name of ['function Field(', 'function Section(', 'function Chip(']) {
      const at = src.indexOf(name);
      expect(at, name).toBeGreaterThan(-1);
      expect(at, `${name} must be above the component`).toBeLessThan(componentStart);
    }
  });
});
