/**
 * THE FOUR PAYLATER ROLES — one per person, from the case journey.
 *
 * CLIENT-SAFE (no `server-only`): the Employees card renders this list as a
 * dropdown and the server validates against the same array, so the UI can never
 * offer a value the database would refuse.
 *
 * WHY A ROLE AND NOT A SET OF CAPABILITIES. These are jobs, not permissions,
 * and they are mutually exclusive. The Lawyer stamps and signs the notice; the
 * Auditor audits and prints the legal memo. They are two people checking each
 * other's work, so one person holding both turns a review into a self-review.
 * Four checkboxes said the opposite — that the roles stack — which is why this
 * moved out of CAPABILITY_TREE and onto memberships.paylater_role in #35.
 *
 * THE STORED VALUES ARE PERMANENT. They sit in a check constraint and in every
 * membership row, so renaming one silently strips people of their role. Add new
 * ones; never repurpose an old one.
 */

export const PAYLATER_ROLES = [
  {
    value: 'team_leader',
    en: 'Team Leader',
    ar: 'رئيس الفريق',
    hintEn: 'Divides batches, assigns notice dates, reviews the final notice, and may override.',
    hintAr: 'يقسّم الدفعات ويحدد تواريخ الإنذار ويراجع الإنذار النهائي وله حق التجاوز.',
  },
  {
    value: 'employee',
    en: 'Employee',
    ar: 'موظف',
    hintEn: 'Prepares files, sends notices, handles communication and settlements.',
    hintAr: 'يجهّز الملفات ويرسل الإنذارات ويتابع المراسلات والتسويات.',
  },
  {
    value: 'lawyer',
    en: 'Lawyer',
    ar: 'محامٍ',
    hintEn: 'Stamps and signs notices.',
    hintAr: 'يختم ويوقّع الإنذارات.',
  },
  {
    value: 'auditor',
    en: 'Auditor',
    ar: 'مدقق',
    hintEn: 'Audits and prints the legal memos.',
    hintAr: 'يدقق ويطبع المذكرات القانونية.',
  },
] as const;

export type PaylaterRole = (typeof PAYLATER_ROLES)[number]['value'];

/** Narrow an untrusted value to a role, or null. Used by the API and the shell. */
export function toPaylaterRole(v: unknown): PaylaterRole | null {
  if (typeof v !== 'string') return null;
  const hit = PAYLATER_ROLES.find((r) => r.value === v);
  return hit ? hit.value : null;
}

/** The label for a role in one language. Falls back to the stored value. */
export function paylaterRoleLabel(
  role: PaylaterRole | null,
  lang: 'en' | 'ar'
): string {
  if (!role) return '';
  const hit = PAYLATER_ROLES.find((r) => r.value === role);
  if (!hit) return role;
  return lang === 'ar' ? hit.ar : hit.en;
}
