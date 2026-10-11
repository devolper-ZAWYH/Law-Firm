/**
 * THE TWELVE MONTHS A BATCH CAN COVER.
 *
 * CLIENT-SAFE (no `server-only`): the New-batch form renders this list and the
 * API validates against the same array, so the dropdown cannot offer a value
 * the route would reject.
 *
 * THE STORED VALUE IS THE UPPERCASE ENGLISH NAME — 'FEBRUARY', not 'February'
 * and not 'فبراير'. That is exactly how the firm's own Progress Report spells
 * it, and it is what the seven imported batches already carry. A batch created
 * in the portal has to sit alongside those without a second spelling of the
 * same month appearing in the data, so the value is fixed and only the LABEL is
 * translated.
 *
 * WHY THIS IS VALIDATED IN THE ROUTE BUT NOT IN THE DATABASE. Migration #34
 * deliberately left `month` as free TEXT, because the IMPORTER writes whatever
 * the source document says, and a check constraint there would turn a
 * misspelling in next month's spreadsheet into a failed import rather than a
 * reported problem — the repo's rule for source data. The portal's own form is
 * a different matter: it is the one writer we control, so it is held to the
 * list. Tolerant at the import boundary, strict at the keyboard.
 */

export const PAYLATER_MONTHS = [
  { value: 'JANUARY', en: 'January', ar: 'يناير' },
  { value: 'FEBRUARY', en: 'February', ar: 'فبراير' },
  { value: 'MARCH', en: 'March', ar: 'مارس' },
  { value: 'APRIL', en: 'April', ar: 'أبريل' },
  { value: 'MAY', en: 'May', ar: 'مايو' },
  { value: 'JUNE', en: 'June', ar: 'يونيو' },
  { value: 'JULY', en: 'July', ar: 'يوليو' },
  { value: 'AUGUST', en: 'August', ar: 'أغسطس' },
  { value: 'SEPTEMBER', en: 'September', ar: 'سبتمبر' },
  { value: 'OCTOBER', en: 'October', ar: 'أكتوبر' },
  { value: 'NOVEMBER', en: 'November', ar: 'نوفمبر' },
  { value: 'DECEMBER', en: 'December', ar: 'ديسمبر' },
] as const;

export type PaylaterMonth = (typeof PAYLATER_MONTHS)[number]['value'];

/**
 * Narrow an untrusted value to a month, or null.
 *
 * Case-insensitive and trimmed, so a value that arrives as 'September' or
 * ' JULY ' is accepted and STORED in the canonical uppercase form rather than
 * being refused on a difference nobody meant.
 */
export function toPaylaterMonth(v: unknown): PaylaterMonth | null {
  if (typeof v !== 'string') return null;
  const needle = v.trim().toUpperCase();
  const hit = PAYLATER_MONTHS.find((m) => m.value === needle);
  return hit ? hit.value : null;
}

/** The label for a month in one language. Falls back to the stored value. */
export function paylaterMonthLabel(
  month: string | null,
  lang: 'en' | 'ar'
): string {
  if (!month) return '';
  const hit = PAYLATER_MONTHS.find((m) => m.value === month.trim().toUpperCase());
  // An imported month this list does not know still shows itself, rather than
  // vanishing from the folder it labels.
  if (!hit) return month;
  return lang === 'ar' ? hit.ar : hit.en;
}
