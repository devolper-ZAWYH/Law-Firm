/**
 * SINGLE-COMPANY MODE — reversible feature flag (no DB change, no data deleted).
 *
 * When `ONLY_COMPANY_NAME_EN` is a non-empty string, the platform operates in
 * SINGLE-COMPANY MODE: the UI shows ONLY that one company everywhere companies
 * are enumerated for the user (the company switcher, the overview "your
 * companies" list, and therefore the resolved ACTIVE company). Every other
 * company (Finjan, Zawyh, …) is HIDDEN from the whole UI — their rows,
 * memberships, files, tasks and all data stay fully intact in the database.
 *
 * To restore full MULTI-COMPANY mode later: set `ONLY_COMPANY_NAME_EN` to
 * `null`. That is the ONLY change required — the filter below becomes a no-op
 * and the platform returns to showing every company. Nothing else is hardcoded.
 *
 * WHY PIN BY name_en (not an id/slug): the `companies` table has NO slug column,
 * and its `id` is `gen_random_uuid()` — a different value in every environment
 * (see supabase/schema_platform.sql + supabase/seed_platform.sql). The English
 * name is the ONLY stable, deterministic identifier the seed guarantees, so we
 * pin to it exactly: 'Ali AlBaker Law Firm' (Arabic: 'مكتب علي الباكر للمحاماة').
 *
 * SECURITY: this flag only ever NARROWS what is shown. It filters a DISPLAY list
 * (companies the user may switch to); it never touches `memberships`, so all
 * existing per-company `company_id` scoping and authorization are unchanged. It
 * cannot widen access — a user with no membership in the pinned company simply
 * sees an empty (no-company) state, never another company's data.
 */

/** The single company to show, by exact `companies.name_en`. `null` ⇒ multi-company. */
export const ONLY_COMPANY_NAME_EN: string | null = 'Ali AlBaker Law Firm';

/** True when the platform is pinned to a single company. */
export function isSingleCompanyMode(): boolean {
  return typeof ONLY_COMPANY_NAME_EN === 'string' && ONLY_COMPANY_NAME_EN.length > 0;
}

/**
 * Narrow a list of companies (anything carrying an English name) down to the
 * single pinned company when single-company mode is on; otherwise return it
 * unchanged. Pure + generic so it can gate any display list.
 */
export function filterToOnlyCompany<T extends { nameEn: string }>(companies: T[]): T[] {
  if (!isSingleCompanyMode()) return companies;
  return companies.filter((c) => c.nameEn === ONLY_COMPANY_NAME_EN);
}
