// The court levels a case can sit at. Client-safe (no server-only imports).
//
// ── Why a fixed list, and why a KEY rather than the label ───────────────────
//
// `case_level` was free text. Two people typing "Appeal" and "استئناف" produced
// two different values for the same court, and neither could be filtered,
// grouped or reported on. A litigation file's level is not an opinion — there
// are three, they are defined by the court system, and they do not change.
//
// What is STORED is the key. The label is chosen at render from the reader's
// language, so the same file reads correctly to an Arabic-speaking lawyer and
// an English-speaking one. Storing the label instead would mean the value
// depends on who happened to create the record.

import type { Lang } from './i18n';

export interface CaseLevel {
  key: string;
  en: string;
  ar: string;
}

/** In the order a case moves through them, which is the order to show them in. */
export const CASE_LEVELS: CaseLevel[] = [
  { key: 'first_instance', en: 'Court of First Instance', ar: 'المحكمة الابتدائية' },
  { key: 'appeal', en: 'Court of Appeal', ar: 'محكمة الاستئناف' },
  { key: 'cassation', en: 'Court of Cassation', ar: 'محكمة التمييز' },
];

const BY_KEY = new Map(CASE_LEVELS.map((level) => [level.key, level]));

/**
 * The label for a stored value, in the reader's language.
 *
 * ── Anything unrecognised is returned AS IT WAS TYPED ────────────────────────
 *
 * The column held free text before this list existed, so files carry whatever
 * somebody wrote — "ابتدائي", "First instance", "Appeal (2nd)". Returning an
 * empty string for those would blank a field on records nobody has touched, and
 * the firm would discover it by noticing information had gone missing.
 *
 * So a legacy value keeps showing exactly what it says. It is not one of the
 * three, and the dropdown says so by offering it as its own option — the file
 * is corrected when somebody next edits it, not by a migration that guesses.
 */
export function caseLevelLabel(value: string | null | undefined, lang: Lang): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const known = BY_KEY.get(raw);
  if (known) return lang === 'ar' ? known.ar : known.en;
  return raw;
}

/** Whether a stored value is one of the three, or something typed before. */
export function isKnownCaseLevel(value: string | null | undefined): boolean {
  return BY_KEY.has((value ?? '').trim());
}
