/**
 * INTAKE COMPLETENESS — the pure rules, with no database behind them.
 *
 * CLIENT-SAFE (no `server-only`), unlike lib/platform/paylater.ts. The batch
 * table and the customer form both need to say what a file is missing while
 * someone is typing, and the save route needs the same answer to decide what to
 * store. One definition, used on both sides, so the chip on the screen and the
 * flag in the database can never disagree.
 *
 * WHY "COMPLETE" ALONE WAS NOT ENOUGH. All 560 imported files are incomplete,
 * and for the same reason: they came from the Progress Report and the
 * enforcement file, which carry none of the intake detail. Not one has a
 * gender, a report date, a registration date or a single order — that lives in
 * the customer's PDF report, which was never part of that export.
 *
 * A column of 560 identical "Incomplete" chips is not information. So the rule
 * still decides completeness, but the UI names the parts that are absent.
 */

export type IntakePart = 'gender' | 'reportDate' | 'regDate' | 'orders';

export interface IntakeFields {
  gender: string | null;
  reportDate: string | null;
  paylaterRegDate: string | null;
  orderCount: number;
}

/** Which parts of the intake record are still missing. Empty means complete. */
export function missingIntakeParts(c: IntakeFields): IntakePart[] {
  const missing: IntakePart[] = [];
  if (!c.gender) missing.push('gender');
  if (!c.reportDate) missing.push('reportDate');
  if (!c.paylaterRegDate) missing.push('regDate');
  if (c.orderCount === 0) missing.push('orders');
  return missing;
}

/**
 * v2's مكتمل / ناقص rule, lifted verbatim: a file is complete when it has a
 * gender, a report date, a PayLater registration date, at least one order, and
 * every order fully filled in.
 *
 * An Excel-imported customer is incomplete BY DEFINITION — order detail exists
 * only in the PDF reports — which is what the per-batch pending count counts
 * down.
 */
export function isCustomerComplete(c: {
  gender: string | null;
  reportDate: string | null;
  paylaterRegDate: string | null;
  orders: {
    orderRef: string | null;
    orderDate: string | null;
    storeAr: string | null;
    amount: number | null;
    instalment: number | null;
    paidCount: number | null;
    paidTotal: number | null;
    remaining: number | null;
  }[];
}): boolean {
  const missing = missingIntakeParts({
    gender: c.gender,
    reportDate: c.reportDate,
    paylaterRegDate: c.paylaterRegDate,
    orderCount: c.orders.length,
  });
  if (missing.length > 0) return false;

  // Every order has to be filled in, not merely present.
  return c.orders.every(
    (o) =>
      !!o.orderRef &&
      !!o.orderDate &&
      !!o.storeAr &&
      o.amount !== null &&
      o.instalment !== null &&
      o.paidCount !== null &&
      o.paidTotal !== null &&
      o.remaining !== null
  );
}

/**
 * The same verdict from the four PARTS rather than from a full record.
 *
 * `isCustomerComplete` needs every order's fields, which a caller that has only
 * counted the orders does not have. Both answer the same question; this one is
 * for the paths that are filling one field and need to know whether that
 * finished the file.
 */
export function isCustomerCompleteFromParts(c: IntakeFields): boolean {
  return missingIntakeParts(c).length === 0;
}
