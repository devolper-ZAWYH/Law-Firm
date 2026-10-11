/**
 * THE FIELDS THAT DESCRIBE THE PERSON, NOT THE DEBT.
 *
 * A customer can hold more than one file: the same person, in more than one
 * month's batch, each file carrying its own debt. Five of a hundred did in the
 * batch this was built against.
 *
 * Their DEBT is per file and must never be copied — the whole point of separate
 * files is that each records its own claim, orders, notice and case. But the
 * PERSON is one person. Correcting a misspelt Arabic name, or a mobile number,
 * or confirming a gender on one file leaves every other file still wrong, and
 * the wrong one is as likely to be the one a notice is built from.
 *
 * So this list is exactly v2's "customer details" section, minus the values
 * that are derived rather than typed (the nationality adjective, which follows
 * from nationality and gender). It is the only set the portal will ever offer
 * to copy between a person's files, and both the form and the save route read
 * it from here so the question asked on screen and the write performed on the
 * server cannot drift apart.
 *
 * CLIENT-SAFE — no `server-only`. Importing a server-only module into the form
 * builds green under tsc and fails at runtime; there is a test for that.
 */

/** Form field name → the column it is stored in. */
export const IDENTITY_FIELDS = {
  nameAr: 'name_ar',
  nameEn: 'name_en',
  qidName: 'qid_name',
  qid: 'qid',
  nationality: 'nationality',
  gender: 'gender',
  paylaterRegDate: 'paylater_reg_date',
  mobile: 'mobile',
  email: 'email',
} as const;

export type IdentityField = keyof typeof IDENTITY_FIELDS;

export const IDENTITY_FIELD_NAMES = Object.keys(IDENTITY_FIELDS) as IdentityField[];

export function isIdentityField(name: string): name is IdentityField {
  return Object.prototype.hasOwnProperty.call(IDENTITY_FIELDS, name);
}

/**
 * Which identity fields differ between what was loaded and what is on screen.
 *
 * Compared as trimmed strings: a null and an empty box are the same absence,
 * and " 9744… " and "9744…" are the same number. Anything that reads as
 * unchanged must not be offered for copying, or the dialog fills with fields
 * nobody touched and stops being read.
 */
export function changedIdentityFields(
  before: Partial<Record<IdentityField, unknown>>,
  after: Partial<Record<IdentityField, unknown>>
): IdentityField[] {
  const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  return IDENTITY_FIELD_NAMES.filter((f) => norm(before[f]) !== norm(after[f]));
}
