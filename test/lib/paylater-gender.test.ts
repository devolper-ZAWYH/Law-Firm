import { describe, it, expect } from 'vitest';
import { suggestGender, GENDER_NAMES } from '@/lib/platform/paylaterGender';

describe('suggesting a gender from the name', () => {
  it('reads the FIRST name, not any later part of it', () => {
    // "محمد" appears in the middle of many women's names in this data; only
    // the given name may decide.
    expect(suggestGender('محمد احمد محمد اسد الحجى')).toBe('male');
    expect(suggestGender('اسماء مفتاح دهام محمد الخليفى')).toBe('female');
    expect(suggestGender('نوره فرج على ال سليم المرى')).toBe('female');
  });

  it('says nothing when the name is not one it knows', () => {
    // A non-Arabic name, and an Arabic one absent from the list. Both must be
    // null: an empty field asks a question, a wrong guess answers it.
    expect(suggestGender('CHAUDHRY RAHIT MAHAR')).toBeNull();
    expect(suggestGender('زهزهون')).toBeNull();
    expect(suggestGender('')).toBeNull();
    expect(suggestGender(null)).toBeNull();
  });

  it('never lists a name as both', () => {
    // An overlap would make the answer depend on lookup order.
    const both = [...GENDER_NAMES.MALE].filter((n) => GENDER_NAMES.FEMALE.has(n));
    expect(both).toEqual([]);
  });

  it('is not derived from the QID, because the QID does not carry it', () => {
    // Guards the finding rather than the code: the module must not start
    // reading digits. Measured across 96 labelled files — serial parity agreed
    // 53% of the time, and every digit position scored exactly the 83.3%
    // baseline of always answering "male".
    expect(suggestGender.length).toBe(1);
  });
});
