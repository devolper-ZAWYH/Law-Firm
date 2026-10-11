// Shared, client-safe date/date-time formatting for the whole platform.
//
// ONE rule for dates everywhere: day + long month + year, with LATIN (0-9)
// digits in BOTH languages and NO comma — e.g.
//   • ar → "9 يوليو 2026"   (Arabic month name, Latin numerals, no comma)
//   • en → "9 July 2026"
//
// Arabic normally renders Eastern Arabic-Indic numerals ("٩") and injects a
// comma ("٩ يوليو، ٢٠٢٦"). We force Latin digits via the `-u-nu-latn` locale
// extension and rebuild the string from `formatToParts` (day/month/year only),
// so any locale-injected literal — comma included — is definitively dropped.

import type { Lang } from './i18n';

/** Coerce an ISO string / epoch / Date into a valid Date, or null. */
function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** BCP-47 locale: Latin numbering system in Arabic, en-GB (day-first) in English. */
function localeFor(lang: Lang): string {
  return lang === 'ar' ? 'ar-QA-u-nu-latn' : 'en-GB';
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};

/**
 * Format a date as "9 يوليو 2026" (ar) / "9 July 2026" (en). Latin digits, no
 * comma. Invalid/empty input renders as an empty string (never "Invalid Date").
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  lang: Lang
): string {
  const d = toDate(value);
  if (!d) return '';
  try {
    const fmt = new Intl.DateTimeFormat(localeFor(lang), DATE_OPTS);
    // Keep only the day/month/year fields (drops commas and other literals) and
    // join with a single space, preserving the locale's own field order.
    const parts = fmt
      .formatToParts(d)
      .filter(
        (p) => p.type === 'day' || p.type === 'month' || p.type === 'year'
      );
    return parts.length > 0 ? parts.map((p) => p.value).join(' ') : fmt.format(d);
  } catch {
    // Last-resort ISO date (already Latin digits, no comma).
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Format a date + 12h time as "9 يوليو 2026 2:05 PM" / "9 July 2026 2:05 PM".
 * Latin digits, no comma. Invalid/empty input → empty string.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  lang: Lang
): string {
  const d = toDate(value);
  if (!d) return '';
  const datePart = formatDate(d, lang);
  try {
    const timePart = new Intl.DateTimeFormat(localeFor(lang), {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
    return datePart ? `${datePart} ${timePart}` : timePart;
  } catch {
    return datePart;
  }
}

/**
 * Just the month name — "يوليو" (ar) / "July" (en). Invalid/empty input → ''.
 */
export function formatMonthLong(
  value: string | number | Date | null | undefined,
  lang: Lang
): string {
  const d = toDate(value);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(localeFor(lang), { month: 'long' }).format(d);
  } catch {
    return '';
  }
}

/**
 * Format a whole-number minute count as a duration — hours + leftover
 * minutes, never days (attendance shifts don't run that long):
 *   • 60    → "1h" (ar: "1 س")
 *   • 93    → "1h 33m" (ar: "1 س 33 د")
 *   • 1500  → "25h" (ar: "25 س") — stays in hours no matter how large.
 *   • 0-59  → "{n}m" (ar: "{n} د")
 * Negative/non-finite input renders as "0m".
 */
export function formatMinutesDuration(totalMinutes: number, lang: Lang): string {
  const n = Number.isFinite(totalMinutes) && totalMinutes > 0 ? Math.round(totalMinutes) : 0;
  const hours = Math.floor(n / 60);
  const minutes = n % 60;
  const ar = lang === 'ar';
  if (hours === 0) return ar ? `${minutes} د` : `${minutes}m`;
  if (minutes === 0) return ar ? `${hours} س` : `${hours}h`;
  return ar ? `${hours} س ${minutes} د` : `${hours}h ${minutes}m`;
}
