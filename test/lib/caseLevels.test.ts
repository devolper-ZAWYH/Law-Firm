import { describe, expect, it } from 'vitest';
import { CASE_LEVELS, caseLevelLabel, isKnownCaseLevel } from '@/lib/caseLevels';

/**
 * `case_level` was a free-text box. Two people typing "Appeal" and "استئناف"
 * produced two values for the same court, and neither could be filtered or
 * grouped. It is a dropdown now, which raises the one question that matters:
 * what happens to everything already typed.
 */

describe('the three levels', () => {
  it('are the court levels, in the order a case moves through them', () => {
    expect(CASE_LEVELS.map((level) => level.key)).toEqual([
      'first_instance',
      'appeal',
      'cassation',
    ]);
  });

  it('reads correctly in both languages', () => {
    expect(caseLevelLabel('first_instance', 'en')).toBe('Court of First Instance');
    expect(caseLevelLabel('first_instance', 'ar')).toBe('المحكمة الابتدائية');
    expect(caseLevelLabel('appeal', 'en')).toBe('Court of Appeal');
    expect(caseLevelLabel('appeal', 'ar')).toBe('محكمة الاستئناف');
    expect(caseLevelLabel('cassation', 'en')).toBe('Court of Cassation');
    expect(caseLevelLabel('cassation', 'ar')).toBe('محكمة التمييز');
  });

  it('stores a key, not a label', () => {
    /**
     * The stored value must not depend on who created the record. If the label
     * were stored, the same court would be "Court of Appeal" on one file and
     * "محكمة الاستئناف" on another, and no report could put them together.
     */
    for (const level of CASE_LEVELS) {
      expect(level.key).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('values typed before the list existed', () => {
  it('are shown exactly as they were written', () => {
    // Returning an empty string would blank a field on records nobody has
    // touched, and the firm would find out by noticing information had gone.
    for (const legacy of ['ابتدائي', 'First instance', 'Appeal (2nd)', 'تمييز']) {
      expect(caseLevelLabel(legacy, 'en')).toBe(legacy);
      expect(caseLevelLabel(legacy, 'ar')).toBe(legacy);
    }
  });

  it('are reported as not one of the three, so the dropdown can offer them', () => {
    expect(isKnownCaseLevel('ابتدائي')).toBe(false);
    expect(isKnownCaseLevel('Appeal')).toBe(false);
    expect(isKnownCaseLevel('appeal')).toBe(true);
  });

  it('are not confused with a label that happens to match', () => {
    // Somebody who typed the full English name before the list existed still
    // has free text, not a key — and it must not be treated as one.
    expect(isKnownCaseLevel('Court of Appeal')).toBe(false);
    expect(caseLevelLabel('Court of Appeal', 'ar')).toBe('Court of Appeal');
  });
});

describe('an unset level', () => {
  it('is empty, not the word "null"', () => {
    expect(caseLevelLabel(null, 'en')).toBe('');
    expect(caseLevelLabel(undefined, 'ar')).toBe('');
    expect(caseLevelLabel('', 'en')).toBe('');
    expect(caseLevelLabel('   ', 'en')).toBe('');
  });

  it('is not "known", so nothing offers it as a legacy option', () => {
    expect(isKnownCaseLevel(null)).toBe(false);
    expect(isKnownCaseLevel('')).toBe(false);
  });
});

describe('stored values survive a round trip', () => {
  it('every key maps back to a non-empty label in both languages', () => {
    for (const level of CASE_LEVELS) {
      expect(caseLevelLabel(level.key, 'en').length).toBeGreaterThan(0);
      expect(caseLevelLabel(level.key, 'ar').length).toBeGreaterThan(0);
      expect(isKnownCaseLevel(level.key)).toBe(true);
    }
  });

  it('tolerates surrounding whitespace from the column', () => {
    expect(caseLevelLabel('  appeal  ', 'en')).toBe('Court of Appeal');
  });
});

describe('what the server accepts', () => {
  /**
   * The dropdown restricts the UI. It is not a control — a crafted request
   * bypasses the form entirely — so the routes accept only the three keys, a
   * clear, or (on edit) exactly what the folder already holds.
   */
  it('recognises the three keys and nothing else', () => {
    expect(isKnownCaseLevel('first_instance')).toBe(true);
    expect(isKnownCaseLevel('appeal')).toBe(true);
    expect(isKnownCaseLevel('cassation')).toBe(true);

    expect(isKnownCaseLevel('Cassation')).toBe(false);
    expect(isKnownCaseLevel('محكمة التمييز')).toBe(false);
    expect(isKnownCaseLevel('whatever the caller likes')).toBe(false);
    expect(isKnownCaseLevel('')).toBe(false);
    expect(isKnownCaseLevel(null)).toBe(false);
    expect(isKnownCaseLevel(undefined)).toBe(false);
  });

  it('does not treat a LABEL as a key', () => {
    // Storing the label would make the value depend on the language of
    // whoever created the record.
    expect(isKnownCaseLevel('Court of Cassation')).toBe(false);
    expect(caseLevelLabel('Court of Cassation', 'en')).toBe('Court of Cassation');
  });
});
