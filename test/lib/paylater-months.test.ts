import { describe, expect, it } from 'vitest';
import {
  PAYLATER_MONTHS,
  toPaylaterMonth,
  paylaterMonthLabel,
} from '@/lib/platform/paylaterMonths';

/**
 * The month a batch covers is a CHOICE, not free text.
 *
 * It is also the batch's label everywhere it appears, and it is stored as the
 * uppercase English name the firm's Progress Report uses. The seven imported
 * batches already carry FEBRUARY…AUGUST, so a portal-created batch that stored
 * 'September' or 'سبتمبر' would put a second spelling of one month into the
 * same column.
 */
describe('PAYLATER_MONTHS', () => {
  it('is twelve months in calendar order', () => {
    expect(PAYLATER_MONTHS).toHaveLength(12);
    expect(PAYLATER_MONTHS[0].value).toBe('JANUARY');
    expect(PAYLATER_MONTHS[11].value).toBe('DECEMBER');
  });

  it('stores the uppercase English name, matching the imported batches', () => {
    // These seven are the values already in the database.
    for (const m of ['FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST']) {
      expect(PAYLATER_MONTHS.map((x) => x.value)).toContain(m);
    }
  });

  it('carries a label in both languages for every month', () => {
    for (const m of PAYLATER_MONTHS) {
      expect(m.en.length).toBeGreaterThan(2);
      expect(m.ar.length).toBeGreaterThan(2);
    }
  });
});

describe('toPaylaterMonth', () => {
  it('accepts each canonical value', () => {
    for (const m of PAYLATER_MONTHS) expect(toPaylaterMonth(m.value)).toBe(m.value);
  });

  it('normalises case and surrounding space rather than refusing', () => {
    // A difference nobody meant should not be an error — it should be tidied.
    expect(toPaylaterMonth('September')).toBe('SEPTEMBER');
    expect(toPaylaterMonth('  july  ')).toBe('JULY');
  });

  it('rejects a misspelling, which is the whole point of the dropdown', () => {
    for (const bad of ['SEPTEMEBR', 'SEPT', 'Sept.', '13', '', 'يناير', null, {}]) {
      expect(toPaylaterMonth(bad)).toBeNull();
    }
  });
});

describe('paylaterMonthLabel', () => {
  it('translates without changing what is stored', () => {
    expect(paylaterMonthLabel('FEBRUARY', 'en')).toBe('February');
    expect(paylaterMonthLabel('FEBRUARY', 'ar')).toBe('فبراير');
  });

  it('shows an unknown imported month as itself rather than blanking the folder', () => {
    // The importer is deliberately NOT held to this list, so a value from a
    // future source document must still label its batch.
    expect(paylaterMonthLabel('RAMADAN', 'en')).toBe('RAMADAN');
    expect(paylaterMonthLabel(null, 'ar')).toBe('');
  });
});
