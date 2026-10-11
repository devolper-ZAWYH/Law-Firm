import { describe, expect, it } from 'vitest';
import { isTrailingZeroQid } from '@/components/collections/CustomerForm';

/**
 * The 12-digit QIDs are a SPREADSHEET ARTIFACT, not people with longer IDs.
 * Three independent lines of evidence, recorded so nobody re-litigates it from
 * memory:
 *
 *   1. All 258 affected QIDs end in 0. A genuine 12-digit number would spread
 *      its final digit across 0–9.
 *   2. A Qatari QID encodes [century][YY][country][serial]. Reading only the
 *      first 11 digits, the embedded country code matches the customer's stated
 *      nationality 239/258 times — the same hit rate as the 300 untouched
 *      11-digit QIDs (292/300), including the same handful of naturalised
 *      Qataris who carry a foreign origin code in BOTH groups.
 *   3. The batches never affected (C100, D100, E100) and the four records
 *      seeded in the v2 prototype are all 11 digits.
 *
 * The predicate must stay narrow: it decides which records get a calm hint
 * instead of a warning, and which are swept up by the bulk correction. Widening
 * it would silently strip a digit off a QID that never had one added.
 */
describe('isTrailingZeroQid', () => {
  it('matches the artifact: 11 digits followed by a zero', () => {
    expect(isTrailingZeroQid('299000000030')).toBe(true);
    expect(isTrailingZeroQid('283634035570')).toBe(true);
  });

  it('does not match a correct 11-digit QID', () => {
    expect(isTrailingZeroQid('29900000003')).toBe(false);
    // …including one that legitimately ends in zero.
    expect(isTrailingZeroQid('29373601680')).toBe(false);
  });

  it('does not match a 12-digit value ending in anything but zero', () => {
    // If one of these ever appears it is NOT the known artifact and must keep
    // its warning rather than being quietly stripped.
    for (const q of ['299000000031', '299000000035', '299000000039']) {
      expect(isTrailingZeroQid(q)).toBe(false);
    }
  });

  it('does not match the genuinely malformed QIDs', () => {
    // B100 #23 and #40 — individually broken, individually fixable, and they
    // must keep warning on the file itself.
    expect(isTrailingZeroQid('045112026')).toBe(false);
    expect(isTrailingZeroQid('20')).toBe(false);
  });

  it('does not match a longer or non-numeric value', () => {
    for (const q of ['2990000000300', '29900000003O', '', '  ', 'abcdefghijk0']) {
      expect(isTrailingZeroQid(q)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace, since a pasted QID often carries it', () => {
    expect(isTrailingZeroQid('  299000000030  ')).toBe(true);
  });
});
