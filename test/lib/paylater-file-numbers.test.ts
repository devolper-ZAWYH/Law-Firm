import { describe, expect, it } from 'vitest';
import { assignFileNumbers, isCustomerComplete } from '@/lib/platform/paylater';

/**
 * v2's file-numbering rule, which is not obvious and is easy to break:
 * numbers come from QID order (smallest QID is 001), a manual override STICKS,
 * and the automatic sequence WORKS AROUND the override rather than renumbering
 * everyone beneath it.
 */
describe('assignFileNumbers', () => {
  const p = (id: string, qid: string | null, manual: string | null = null) => ({
    id,
    qid,
    fileNoManual: manual,
  });

  it('numbers from QID order, smallest first', () => {
    const out = assignFileNumbers([
      p('c', '30000000003'),
      p('a', '10000000001'),
      p('b', '20000000002'),
    ]);
    expect(out.get('a')?.number).toBe('001');
    expect(out.get('b')?.number).toBe('002');
    expect(out.get('c')?.number).toBe('003');
  });

  it('a manual override keeps its number and is marked manual', () => {
    const out = assignFileNumbers([p('a', '10000000001', '077')]);
    expect(out.get('a')).toEqual({ number: '077', manual: true });
  });

  it('the automatic sequence skips a number claimed by hand', () => {
    // 'b' has claimed 002, so the second automatic file must take 003.
    const out = assignFileNumbers([
      p('a', '10000000001'),
      p('b', '20000000002', '002'),
      p('c', '30000000003'),
    ]);
    expect(out.get('a')?.number).toBe('001');
    expect(out.get('b')?.number).toBe('002');
    expect(out.get('c')?.number).toBe('003');
    expect(out.get('c')?.manual).toBe(false);
  });

  it('skips a manual number even when it sits at the front of the sequence', () => {
    const out = assignFileNumbers([
      p('a', '10000000001'),
      p('z', '90000000009', '001'),
    ]);
    expect(out.get('z')?.number).toBe('001');
    // 'a' would have been 001; it must move rather than collide.
    expect(out.get('a')?.number).toBe('002');
  });

  /**
   * QIDs are compared as PADDED STRINGS, not numbers. B100 #23's real QID is
   * `045112026` — a leading zero that numeric parsing would destroy, and a
   * shorter value that naive string comparison would sort as though it were
   * enormous.
   */
  it('sorts mixed-length QIDs by value, preserving a leading zero', () => {
    const out = assignFileNumbers([
      p('long', '30000000003'),
      p('short', '045112026'),
    ]);
    expect(out.get('short')?.number).toBe('001');
    expect(out.get('long')?.number).toBe('002');
  });

  it('does not fall over on a missing QID', () => {
    const out = assignFileNumbers([p('a', null), p('b', '20000000002')]);
    expect(out.size).toBe(2);
  });
});

/**
 * Completeness is what the per-batch "ناقص" count counts down. An
 * Excel-imported customer must read as INCOMPLETE — the order detail it
 * requires exists only in the PDF reports.
 */
describe('isCustomerComplete', () => {
  const fullOrder = {
    orderRef: 'SQ1',
    orderDate: '2026-01-01',
    storeAr: 'متجر',
    amount: 100,
    instalment: 25,
    paidCount: 2,
    paidTotal: 50,
    remaining: 50,
  };
  const base = {
    gender: 'male',
    reportDate: '2026-08-05',
    paylaterRegDate: '2025-04-20',
    orders: [fullOrder],
  };

  it('is complete when every required field and order is filled', () => {
    expect(isCustomerComplete(base)).toBe(true);
  });

  it('an Excel-imported customer (no orders) is incomplete', () => {
    expect(isCustomerComplete({ ...base, orders: [] })).toBe(false);
  });

  it('is incomplete when gender is missing', () => {
    expect(isCustomerComplete({ ...base, gender: null })).toBe(false);
  });

  it('is incomplete when any single order field is missing', () => {
    expect(
      isCustomerComplete({
        ...base,
        orders: [{ ...fullOrder, remaining: null }],
      })
    ).toBe(false);
  });

  it('treats a zero amount as present, not missing', () => {
    // 0 is a real value here; a truthiness check would wrongly reject it.
    expect(
      isCustomerComplete({
        ...base,
        orders: [{ ...fullOrder, paidCount: 0, paidTotal: 0, remaining: 100 }],
      })
    ).toBe(true);
  });
});
