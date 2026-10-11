import 'server-only';
import { redirect } from 'next/navigation';
import { requirePlatformUser } from '@/lib/platform/auth';
import { paylaterAccess, type PaylaterAccess } from '@/lib/platform/paylater';
import { ONLY_COMPANY_NAME_EN } from '@/lib/platform/singleCompany';
import type { PlatformUser } from '@/lib/platform/auth';

/**
 * The one place a PayLater page or route resolves "may this person be here?".
 *
 * Middleware has already guaranteed the caller is AUTHENTICATED — it cannot do
 * more, because the grant lives in the database and not in the JWT. This is the
 * server-side check that actually decides, and every /paylater page and
 * /api/paylater route calls it. Permission props passed down to components only
 * choose which controls are drawn.
 *
 * A refused caller is sent to the main portal rather than shown an error: they
 * are signed in and the platform works for them, they simply are not in this
 * part of it. Per the house rule, a boundary should read as "not available to
 * you", not as a breakage.
 */
export interface PaylaterContext {
  pu: PlatformUser;
  companyId: string;
  access: PaylaterAccess;
}

export async function requirePaylater(): Promise<PaylaterContext> {
  const pu = await requirePlatformUser();

  // PayLater is scoped to the one company. In single-company mode `companies`
  // is already narrowed to it; the find is what keeps this correct if the
  // platform is ever returned to multi-company mode.
  const company =
    pu.companies.find((c) => c.nameEn === ONLY_COMPANY_NAME_EN) ?? pu.companies[0];
  if (!company) redirect('/admin');

  const access = await paylaterAccess(pu, company.id);
  if (!access.canOpen) redirect('/admin');

  return { pu, companyId: company.id, access };
}

/**
 * The same resolution for API routes, which must answer with a status code
 * rather than a redirect. Returns null when the caller may not be here; the
 * route turns that into a 403.
 */
export async function resolvePaylater(): Promise<PaylaterContext | null> {
  const pu = await requirePlatformUser();
  const company =
    pu.companies.find((c) => c.nameEn === ONLY_COMPANY_NAME_EN) ?? pu.companies[0];
  if (!company) return null;

  const access = await paylaterAccess(pu, company.id);
  if (!access.canOpen) return null;

  return { pu, companyId: company.id, access };
}
