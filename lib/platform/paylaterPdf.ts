/**
 * THE CUSTOMER REPORT PDF — read deterministically, with no model and no key.
 *
 * This settles the question the spec left open. Every one of the 73 customer
 * reports in Batch 7 carries a real text layer — checked, not assumed: 73 of 73
 * extract, all 73 contain the English section, and the two order tables agree
 * on the order count in every file. Nothing here is OCR and nothing is inferred.
 *
 * WHY THAT MATTERS BEYOND THE COST. The spec's own reasoning: for legal work the
 * same document must produce the same output every run. A parser does; a model
 * asked to read a table does not promise to. These figures end up on a notice
 * and in a filing, so "usually identical" is not the same as identical.
 *
 * WHY THE ENGLISH SECTION. The report is bilingual — pages 1–2 Arabic, 3–4
 * English — and the two carry the same numbers. The Arabic pages render digits
 * as Arabic-Indic (١,٢٥٠.٠٠) and dates as Arabic month names, so parsing them
 * means transliterating before you can even compare. The English pages give
 * Latin digits and ISO-ish dates. The ONE thing taken from the Arabic side is
 * the merchant's Arabic name, because v2's rule is that it is copied verbatim
 * from the Arabic column and never translated.
 *
 * THE FIRM'S RULES, kept exactly as v2 stated them:
 *   • Paid and remaining totals are COPIED, never recomputed. The report is the
 *     record; if its own arithmetic disagrees with ours, the report wins and the
 *     difference is something a person should see, not something we silently
 *     paper over.
 *   • An instalment counts as paid ONLY where the status is "Payment success"
 *     («تم الدفع بنجاح»). "Payment pending" never counts, whatever the dates say.
 *   • Orders are returned oldest first.
 *
 * GENDER IS NOT IN HERE, and that is not an oversight — the report does not
 * state it. The spec chose a dropdown over inferring it from a name, so it stays
 * the one intake field a person supplies.
 */

import 'server-only';

/** One purchase, in the shape the intake form and the save route both use. */
export interface ParsedOrder {
  orderRef: string;
  orderDate: string | null;
  storeEn: string | null;
  storeAr: string | null;
  amount: number | null;
  instalment: number | null;
  paidCount: number | null;
  paidTotal: number | null;
  remaining: number | null;
  /** How many instalments this order has, counted from the rows printed. */
  instalmentCount: number;
}

export interface ParsedReport {
  qid: string | null;
  nameEn: string | null;
  nationality: string | null;
  email: string | null;
  mobile: string | null;
  paylaterRegDate: string | null;
  reportDate: string | null;
  /** "Total Outstanding Due" as the report states it. */
  debtTotal: number | null;
  /** The ISO code printed beside that total — QAR in every report so far. */
  currency: string | null;
  orders: ParsedOrder[];
  /**
   * Instalments still unpaid across every order — the figure the monthly Excel
   * carries as INSTALLMENT, reproduced here so the two can be compared.
   */
  pendingInstalments: number;
  /**
   * Anything the parser could not read with confidence. Never silently empty:
   * a field that is absent from the report is reported as absent so the person
   * filling the form knows to look, rather than assuming the PDF was thin.
   */
  warnings: string[];
}

/**
 * An order id: a short letter prefix and a long number.
 *
 * NOT hard-coded to "SQ". The reports carry at least two prefixes — SQ (170
 * orders here) and PL (40) — and a parser that only knew SQ silently returned
 * "no orders" for the nine customers whose orders are all PL, which reads
 * exactly like a customer who has never bought anything.
 */
const ORDER_ID = '[A-Z]{2,4}\\d{6,}';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "05 Aug 2026" → "2026-08-05". */
function dmyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

/** "20/04/2025, 13:40" → "2025-04-20". Day first, as the report writes it. */
function slashToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "1,250.00" → 1250. Returns null rather than NaN so a bad cell is visible. */
function money(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Arabic-Indic digits → Latin, so an Arabic order id can be matched. */
function latinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) =>
    String(d.charCodeAt(0) - 0x0660)
  );
}

/**
 * Pull the text out of a PDF, one string per page.
 *
 * pdfjs is loaded through its `legacy` build: the default build assumes browser
 * globals that do not exist in a Node route handler.
 */
async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // RUN ON THIS THREAD. pdfjs insists on a "worker"; in Node the supported way
  // to satisfy it is to load the worker module for its side effect, which
  // registers it globally, and to point workerSrc at the resolved file as a
  // fallback. Neither is optional here:
  //   • Without the side-effect import it fails with
  //     "Setting up fake worker failed: No GlobalWorkerOptions.workerSrc".
  //   • Without keeping pdfjs-dist OUT of the server bundle (see
  //     next.config.js) the bundler rewrites its internal paths and it fails
  //     with "Cannot find module .../pdf.worker.mjs" instead.
  // There is nothing to gain from a real worker: one document per request.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const { createRequire } = await import('node:module');
    const requireFrom = createRequire(`${process.cwd()}/`);
    pdfjs.GlobalWorkerOptions.workerSrc = requireFrom.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    );
  }
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    // No network fetches for fonts or cmaps — everything needed is embedded.
    useWorkerFetch: false,
    // The report embeds subset fonts whose glyphs are read through their
    // ToUnicode CMaps; no external font data is fetched.
    isEvalSupported: false,
  }).promise;

  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
    );
  }
  await doc.destroy();
  return pages;
}

/**
 * The Arabic merchant name for each order, keyed by order id.
 *
 * The Arabic order summary writes the id with Arabic-Indic digits and a space
 * after "SQ" (`SQ ١٧٦٧٢...`), so both are normalised before matching. The name
 * is whatever sits between the amount and the payment type, copied as-is.
 */
function arabicMerchants(arabicText: string): Map<string, string> {
  const out = new Map<string, string>();
  // amount (Arabic-Indic, with ر.ق) then the merchant, then the payment type.
  const re = new RegExp(
    '([A-Z]{2,4})\\s*([٠-٩]+)\\s+[٠-٩,.]+\\s*ر\\.ق\\s+(.+?)\\s+(?:آبل باي|بطاقة|محفظة|فيزا|ماستر|بطاقة خصم)',
    'g'
  );
  for (const m of arabicText.matchAll(re)) {
    const id = m[1] + latinDigits(m[2]);
    const name = m[3].trim();
    if (name && !out.has(id)) out.set(id, name);
  }
  return out;
}

/**
 * Read a PayLater customer report.
 *
 * Throws only when the file is not a readable PDF at all. A report that IS
 * readable but missing a field comes back with that field null and a warning —
 * the form can then show what was found and let a person supply the rest,
 * which is far more useful than refusing the whole document.
 */
export async function parseCustomerReport(
  bytes: Uint8Array
): Promise<ParsedReport> {
  const pages = await pdfPages(bytes);
  const all = pages.join(' ');
  const warnings: string[] = [];

  if (all.trim().length < 200) {
    throw new Error(
      'This PDF has no text layer — it looks like a scan. Only reports exported from the PayLater portal can be read.'
    );
  }

  // The English half. Everything numeric is read from here.
  const engStart = all.indexOf('CUSTOMER DETAILS');
  if (engStart === -1) {
    throw new Error(
      'This does not look like a PayLater customer report — no CUSTOMER DETAILS section was found.'
    );
  }
  const eng = all.slice(engStart);
  const ara = all.slice(0, engStart);

  const grab = (re: RegExp): string | null => {
    const m = eng.match(re);
    return m ? m[1].trim() : null;
  };

  const qid = grab(/\bQID\s+(\d{6,14})\b/);
  const nameEn = grab(/CUSTOMER NAME\s+(.+?)\s*\(/);
  const nationality = grab(/Nationality\s+(.+?)\s+الجنسيه/);
  const email = grab(/EMAIL\s+(\S+@\S+?)\s/);
  const mobile = grab(/MOBILE\s+(\+?\d{6,15})/);
  const onboarding = grab(/DATE OF ONBOARDING\s+(\d{2}\/\d{2}\/\d{4})/);
  const reportDate = grab(/DATE OF REPORT\s+(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/);
  /*
    THE CURRENCY IS READ, NOT ASSUMED. "QAR" used to be written into this
    pattern, which meant a report in any other currency would not match at all
    and would lose its total silently — the worst way for it to fail, because a
    missing total looks like a thin PDF rather than a wrong assumption. The code
    is captured instead, and reported alongside the number.

    All 73 reports in the batch this was built against state QAR (283 amounts,
    each printed twice — "ر.ق" beside "QAR"). That is a fact about this batch,
    not a rule, which is exactly why it is parsed.
  */
  const totalMatch = eng.match(
    /Total Outstanding Due\s+([A-Z]{3})\s+([\d,]+\.\d{2})/
  );
  const currency = totalMatch?.[1] ?? null;
  const debtTotal = money(totalMatch?.[2] ?? undefined);

  for (const [label, value] of [
    ['QID', qid],
    ['customer name', nameEn],
    ['registration date', onboarding],
    ['report date', reportDate],
  ] as const) {
    if (!value) warnings.push(`The report does not state a ${label}.`);
  }

  // ---- orders -----------------------------------------------------------
  //
  // The LOAN SUMMARY is the authoritative table: one header row per order
  // carrying id, amount, total paid and pending due as four clean numbers.
  // The ORDER SUMMARY above it supplies the order's date and merchant.
  const orders = new Map<string, ParsedOrder>();

  for (const m of eng.matchAll(
    new RegExp(
      `(${ORDER_ID})\\s+([\\d,]+\\.\\d{2})\\s+([\\d,]+\\.\\d{2})\\s+([\\d,]+\\.\\d{2})`,
      'g'
    )
  )) {
    if (orders.has(m[1])) continue;
    orders.set(m[1], {
      orderRef: m[1],
      orderDate: null,
      storeEn: null,
      storeAr: null,
      amount: money(m[2]),
      // COPIED, never recomputed — the report is the record.
      paidTotal: money(m[3]),
      remaining: money(m[4]),
      instalment: null,
      paidCount: null,
      instalmentCount: 0,
    });
  }

  // Date and merchant, from the order-summary rows. The merchant sits between
  // the amount and the payment type; the row always ends with its status.
  const summary =
    eng.split('ORDER DATE(MM/DD/YY)')[1]?.split('Total Outstanding')[0] ?? '';
  for (const m of summary.matchAll(
    new RegExp(
      `(\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4})\\s+(${ORDER_ID})\\s+QAR\\s+([\\d,]+\\.\\d{2})\\s+(.+?)\\s+(?=\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4}\\s+${ORDER_ID}|$)`,
      'g'
    )
  )) {
    const o = orders.get(m[2]);
    if (!o) continue;
    o.orderDate = dmyToIso(m[1]);
    // Strip the trailing payment type and status; what remains is the name.
    o.storeEn =
      m[4]
        .replace(/\s+(Apple Pay|Google Pay|Credit Card|Debit Card|Card|Wallet)\s+\w+$/i, '')
        .replace(/\s+(Active|Closed|Cancelled|Completed|Overdue)$/i, '')
        .trim() || null;
  }

  // Per-instalment rows decide the instalment amount and how many are paid.
  // A row belongs to the order whose loan-summary header most recently
  // preceded it, which is how the report lays the tables out.
  let current: ParsedOrder | undefined;
  const rowRe = new RegExp(
    // an order header…                        …or an instalment row
    `(${ORDER_ID})\\s+[\\d,]+\\.\\d{2}\\s+[\\d,]+\\.\\d{2}\\s+[\\d,]+\\.\\d{2}` +
      // The loan account is followed by ONE to THREE integers before the
      // amount, and which it is varies between reports: one customer's row
      // reads "…143773 4 1 312.50" and another's "…761095 1 250.00". A
      // fixed arity here matched the first and silently skipped every row of
      // the second, which surfaced as a customer with orders but no
      // instalments. `\d+` cannot cross the decimal point, so the amount is
      // never swallowed by the repetition.
      '|\\d{10,}(?:\\s+\\d+){1,3}\\s+([\\d,]+\\.\\d{2})\\s+[\\d,]+\\.\\d{2}\\s+\\S+\\s+\\S+\\s+Payment (success|pending)',
    'g'
  );
  const paid = new Map<string, number>();
  const total = new Map<string, number>();
  const instAmt = new Map<string, number>();
  for (const m of eng.matchAll(rowRe)) {
    if (m[1]) {
      current = orders.get(m[1]);
      continue;
    }
    if (!current) continue;
    const amt = money(m[2]);
    if (amt !== null && !instAmt.has(current.orderRef)) {
      instAmt.set(current.orderRef, amt);
    }
    // The instalment COUNT is the number of rows, not the number sitting in
    // the row's second column — that one varies 0–9 across the corpus and is
    // plainly not a tenure. Counting what is printed cannot drift.
    total.set(current.orderRef, (total.get(current.orderRef) ?? 0) + 1);
    // ONLY "Payment success" counts — v2's «تم الدفع بنجاح» rule.
    if (m[3] === 'success') {
      paid.set(current.orderRef, (paid.get(current.orderRef) ?? 0) + 1);
    }
  }
  for (const o of orders.values()) {
    o.instalment = instAmt.get(o.orderRef) ?? null;
    o.paidCount = paid.get(o.orderRef) ?? 0;
    o.instalmentCount = total.get(o.orderRef) ?? 0;
  }

  // The Arabic merchant name, copied verbatim from the Arabic column.
  const arMerchants = arabicMerchants(ara);
  for (const o of orders.values()) {
    o.storeAr = arMerchants.get(o.orderRef) ?? null;
    if (!o.storeAr) {
      warnings.push(
        `No Arabic merchant name was found for order ${o.orderRef}.`
      );
    }
  }

  if (orders.size === 0) warnings.push('The report lists no orders.');

  // Oldest first — v2's ordering rule.
  const list = [...orders.values()].sort((a, b) =>
    (a.orderDate ?? '9999').localeCompare(b.orderDate ?? '9999')
  );

  // A cross-check the report itself makes possible: the outstanding total it
  // states should equal the sum of what each order still owes. Reported, not
  // corrected — a disagreement is the firm's to resolve, not ours to hide.
  const sumRemaining = list.reduce((s, o) => s + (o.remaining ?? 0), 0);
  if (
    debtTotal !== null &&
    list.length > 0 &&
    Math.abs(sumRemaining - debtTotal) > 0.05
  ) {
    warnings.push(
      `The report states a total of ${debtTotal.toFixed(2)} but its orders leave ${sumRemaining.toFixed(2)} outstanding.`
    );
  }

  return {
    pendingInstalments: list.reduce(
      (s, o) => s + Math.max(0, o.instalmentCount - (o.paidCount ?? 0)),
      0
    ),
    qid,
    nameEn,
    nationality,
    email,
    mobile,
    paylaterRegDate: onboarding ? slashToIso(onboarding) : null,
    reportDate: reportDate ? dmyToIso(reportDate) : null,
    debtTotal,
    currency,
    orders: list,
    warnings,
  };
}
