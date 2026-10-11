/**
 * MONEY, WITH ITS CURRENCY ATTACHED.
 *
 * Every figure in this portal is Qatari riyals, and the prototype showed bare
 * numbers because a prototype can assume its reader knows that. A file that
 * ends in a legal notice cannot: "4,375.00" beside "5" instalments and "120"
 * days is three numbers of three different kinds, and the one that is money is
 * the one that gets read out in court.
 *
 * CLIENT-SAFE — no `server-only`. The table, the form and the import preview
 * all format the same way, so a figure cannot read differently depending on
 * which screen it is on.
 *
 * THE NUMBER AND ITS UNIT ARE ONE LTR RUN. Rendered as separate spans inside an
 * RTL page the unit jumps to the wrong end — "4,375.00 QAR" becomes
 * "QAR 4,375.00" reading right-to-left, which is a different claim. Callers put
 * the whole string in a single `dir="ltr"` element; see the i18n note in
 * CLAUDE.md.
 */

/** ر.ق is what the customer reports themselves print, beside "QAR". */
export const CURRENCY = { ar: 'ر.ق', en: 'QAR' } as const;

/**
 * How to write a currency code for a reader.
 *
 * QAR gets its Arabic form in Arabic, because that is what the reports print
 * and what a notice reads. ANY OTHER CODE IS SHOWN AS ITSELF: inventing an
 * Arabic abbreviation for a currency the firm has not handled would be a
 * guess, and "SAR" is unambiguous in both languages.
 *
 * The code is stored per file (#38) rather than assumed, because the report
 * states it. Every report read so far says QAR — 283 amounts across Batch 7's
 * 73 reports — which is a fact about that batch, not a rule.
 */
export function currencyLabel(lang: 'ar' | 'en', code: string = CURRENCY.en): string {
  return code === CURRENCY.en ? CURRENCY[lang] : code;
}

/**
 * A money figure with its currency, or an empty string for a missing value —
 * never "0.00 QAR" for a figure nobody has recorded. Two decimals always: a
 * claim shown as "3,000" and one shown as "3,000.00" invite the question of
 * whether the fils were dropped.
 */
export function formatMoney(
  value: number | null | undefined,
  lang: 'ar' | 'en',
  code: string = CURRENCY.en
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const n = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n} ${currencyLabel(lang, code)}`;
}

/**
 * For an EDITABLE field the unit belongs in the label, not the value: typing
 * into a box that already contains "QAR" would either be parsed as text or
 * silently stripped, and both are worse than saying it once above the box.
 */
export function moneyLabel(
  label: string,
  lang: 'ar' | 'en',
  code: string = CURRENCY.en
): string {
  return `${label} (${currencyLabel(lang, code)})`;
}
