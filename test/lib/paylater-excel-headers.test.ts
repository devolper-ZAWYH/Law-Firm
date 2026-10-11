import { describe, expect, it } from 'vitest';
import { mapHeaders } from '@/lib/platform/paylaterExcel';

/**
 * The header matching v2 arrived at against the firm's REAL files. Two of these
 * cases are the reason the rule is "exact first, then longest prefix" rather
 * than a plain prefix match, and both regressed in v2 before being fixed:
 *
 *   • `NO.` would claim `Notice Date` (both start "No")
 *   • `Shopper Name` would claim `Shopper Name NATIVE`
 *
 * The typo and the trailing space are the columns' real names. Correcting them
 * would mean failing to read the actual files.
 */
describe('mapHeaders', () => {
  const REAL_HEADER = [
    'NO.',
    'Shopper Name',
    'Shopper Name NATIVE',
    'Phone Number',
    'Email',
    'NATOINALITY',
    'QID',
    'INSTALLMENT',
    'Amount Due (QAR)',
    'DPD',
    'Notice Date',
    'CASE REGISTRATION ',
    'MOI CHECK',
  ];

  it('resolves every column of a real header row', () => {
    const { index } = mapHeaders(REAL_HEADER);
    expect(index.rowNo).toBe(0);
    expect(index.nameEn).toBe(1);
    expect(index.nameAr).toBe(2);
    expect(index.mobile).toBe(3);
    expect(index.email).toBe(4);
    expect(index.nationality).toBe(5);
    expect(index.qid).toBe(6);
    expect(index.instalmentCount).toBe(7);
    expect(index.debtTotal).toBe(8);
    expect(index.dpd).toBe(9);
    expect(index.noticePlanned).toBe(10);
    expect(index.caseRegDate).toBe(11);
  });

  it('does not let "NO." claim "Notice Date"', () => {
    const { index } = mapHeaders(REAL_HEADER);
    expect(index.rowNo).toBe(0);
    expect(index.noticePlanned).toBe(10);
  });

  it('does not let "Shopper Name" claim "Shopper Name NATIVE"', () => {
    const { index } = mapHeaders(REAL_HEADER);
    expect(index.nameEn).toBe(1);
    expect(index.nameAr).toBe(2);
  });

  it('reads the NATOINALITY typo as it is actually spelled', () => {
    const { index } = mapHeaders(['QID', 'Shopper Name', 'NATOINALITY']);
    expect(index.nationality).toBe(2);
  });

  it('reads CASE REGISTRATION despite its trailing space', () => {
    const { index } = mapHeaders(['QID', 'Shopper Name', 'CASE REGISTRATION ']);
    expect(index.caseRegDate).toBe(2);
  });

  it('reports an unknown column as ignored, never as an error', () => {
    // MOI CHECK used to be the example here; it is mapped now, so the test
    // needs a column the sheet really does not carry.
    const { ignored } = mapHeaders([...REAL_HEADER, 'SOMETHING NEW']);
    expect(ignored).toContain('SOMETHING NEW');
  });

  it('maps the MOI residency check rather than dropping it', () => {
    const { index } = mapHeaders(REAL_HEADER);
    expect(index.moiCheck).toBe(REAL_HEADER.indexOf('MOI CHECK'));
  });

  it('reports columns it expected and did not find', () => {
    const { missing } = mapHeaders(['QID', 'Shopper Name']);
    expect(missing).toContain('DPD');
    expect(missing).not.toContain('QID');
  });

  it('is case-insensitive on the exact pass', () => {
    const { index } = mapHeaders(['qid', 'shopper name']);
    expect(index.qid).toBe(0);
    expect(index.nameEn).toBe(1);
  });
});
