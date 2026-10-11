import 'server-only';
import { redirect } from 'next/navigation';
import { getSupabaseAdmin } from '../supabase';
import { getSession } from '../session';
import type { SessionUser } from '../auth';
import { filterToOnlyCompany } from './singleCompany';
import {
  companiesWithAnyPermission,
  companiesWithAttendanceUploadPermission,
} from './permissions';
import { companiesWithAnyCapability } from './capabilityGrants';

/**
 * Platform authorization resolution (Phase 1).
 *
 * THE CORE MODEL — a person does NOT have a single role. A person has
 * MEMBERSHIPS: each membership = (user, company, role ∈ {manager,employee}).
 * PLUS one global boolean flag `app_users.is_admin` (master key over ALL
 * companies).
 *
 * Two-layer authorization, enforced SERVER-SIDE by callers:
 *   (1) if caller.isAdmin → allow admin-level actions globally
 *   (2) else              → require a membership in the TARGET company whose
 *                           role permits the action (see roleInCompany()).
 *
 * Company isolation is a hard boundary: non-admins only ever see data for
 * companies they hold a membership in.
 *
 * All reads use the service-role Supabase client (server-only), exactly like
 * the rest of the app. RLS on companies/memberships is deny-by-default; the
 * service-role key bypasses it for trusted server code.
 */

export type MembershipRole = 'manager' | 'employee';

/** A company the user belongs to, with the role that governs that company. */
export interface Membership {
  companyId: string;
  companyNameEn: string;
  companyNameAr: string;
  role: MembershipRole;
  /**
   * The PayLater role for this membership, read as part of the identity query
   * so PayLater costs no extra round trip. `null` = no role assigned;
   * `undefined` = migration #35 has not run, so the answer is unknown.
   */
  paylaterRole?: string | null;
}

/**
 * A company the user can switch the active context to, with the role that
 * drives their navigation in that company. For an admin this is EVERY company
 * (role 'admin'); for a manager/employee it is exactly their memberships.
 */
export interface SwitchableCompany {
  id: string;
  nameEn: string;
  nameAr: string;
  role: 'admin' | MembershipRole;
  /**
   * True if the user holds a MANAGER membership in this company, INDEPENDENT of
   * the global admin flag. For a global admin who also manages the company
   * (e.g. Yousef) `role` resolves to 'admin' but `isManager` is still true — the
   * UI uses this to surface manager-operator affordances (create task, My Tasks)
   * that require an actual manager membership server-side.
   */
  isManager: boolean;
  /**
   * True if this membership has been granted AT LEAST ONE extra permission
   * (lib/platform/permissions.ts) — e.g. can_create_file. Independent of
   * `isManager`; lets an otherwise-plain employee reach the one admin-shell
   * page their granted permission actually applies to (Folders).
   */
  hasFilePermission: boolean;
  /** Same idea as hasFilePermission, but for can_upload_attendance — gates the Attendance page. */
  hasAttendancePermission: boolean;
  /**
   * Granted 'company.contacts' (read), 'company.contactsAdd' (create) or
   * 'company.contactsEdit' (edit) in this company. Gates the CRM link for a
   * plain employee: without it the page was reachable by URL but appeared in
   * nobody's sidebar, so granting any of them looked like it had done nothing.
   */
  hasCrmPermission: boolean;
  /**
   * May open the Collections portal in this company — an admin, a manager, or
   * anyone holding a Collections role on the membership.
   *
   * Gates the sidebar link. Until this existed the only way in was the portal
   * chooser on the sign-in screen, so anyone already signed in had to sign out
   * to reach a portal they have access to. The link is presentation only; the
   * portal re-resolves the same answer server-side in app/collections/guard.ts.
   *
   * Mirrors paylaterAccess().canOpen deliberately, and is computed from the
   * SAME membership row that identity already read — no extra query. A missing
   * migration #35 leaves paylaterRole `undefined`, which grants nothing: a read
   * that could not prove access must never hand it out.
   */
  hasCollectionsAccess: boolean;
}

export interface PlatformUser {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
  isAdmin: boolean;
  memberships: Membership[];
  companies: SwitchableCompany[];
}

// Raw row shapes (PostgREST returns untyped JSON; we cast defensively).
interface UserRow {
  id: string;
  username: string;
  is_admin: boolean | null;
  full_name_en: string | null;
  full_name_ar: string | null;
  /** Migration #24. A frozen account is treated as signed out. */
  is_frozen: boolean | null;
}
interface MembershipRow {
  company_id: string;
  role: MembershipRole;
  /** Migration #35. Absent on a database that has not run it — see membershipRows. */
  paylater_role?: string | null;
}
interface CompanyRow {
  id: string;
  name_en: string;
  name_ar: string;
}

/**
 * Does this database have migration #35's `memberships.paylater_role`?
 *
 * DEPLOY SAFETY, and the stakes are higher here than usual: this column is read
 * as part of the ONE query that resolves who the caller is, which every
 * protected page and every API route runs. If the column is missing and we do
 * not handle it, the platform does not degrade — it signs everybody out.
 *
 * So the select is attempted with the column and retried once without it. The
 * flag latches, making the cost one wasted round trip per process rather than
 * per request.
 *
 * Reading it here rather than in `paylaterAccess` is what makes PayLater cost
 * the same as the main portal: the role used to be its own query, awaited after
 * this one, so every PayLater navigation paid a full extra round trip to a
 * database on another continent for a single string that this query was already
 * standing next to.
 */
let membershipsHavePaylaterRole = true;

async function membershipRows(userId: string): Promise<MembershipRow[]> {
  const supabase = getSupabaseAdmin();
  const attempt = (withPaylater: boolean) =>
    supabase
      .from('memberships')
      .select(withPaylater ? 'company_id, role, paylater_role' : 'company_id, role')
      .eq('user_id', userId);

  let res = await attempt(membershipsHavePaylaterRole);
  if (res.error?.code === '42703' && membershipsHavePaylaterRole) {
    membershipsHavePaylaterRole = false;
    res = await attempt(false);
  }
  if (res.error) throw new Error(res.error.message);
  // Through `unknown`: supabase-js infers a row shape only from a LITERAL
  // select string, and ours is a runtime variable (the with/without-paylater
  // switch), so the builder's inferred type is a ParserError rather than a row.
  // Same reason as the cast in lib/platform/files.ts.
  return ((res.data as unknown) as MembershipRow[] | null) ?? [];
}

/**
 * Resolve the caller's platform identity: global admin flag + memberships +
 * the set of companies they can switch between. Returns null if the underlying
 * app_users row no longer exists (caller should treat as unauthenticated).
 */
export async function getPlatformUser(
  session: Pick<SessionUser, 'id'>
): Promise<PlatformUser | null> {
  const supabase = getSupabaseAdmin();

  // All five queries below are independent (none needs another's result) —
  // fire them together instead of one-at-a-time. This runs on EVERY
  // navigation (every server-rendered admin/me page calls it), so five
  // sequential round trips vs. one parallel batch is the difference between
  // a page feeling instant and feeling sluggish.
  const [
    userRes,
    memRes,
    compRes,
    permittedCompanyIds,
    attendancePermittedCompanyIds,
    crmPermittedCompanyIds,
  ] = await Promise.all([
      supabase
        .from('app_users')
        .select('id, username, is_admin, full_name_en, full_name_ar, is_frozen')
        .eq('id', session.id)
        .maybeSingle(),
      membershipRows(session.id),
      supabase
        .from('companies')
        .select('id, name_en, name_ar')
        .order('created_at', { ascending: true }),
      companiesWithAnyPermission(session.id),
      companiesWithAttendanceUploadPermission(session.id),
      companiesWithAnyCapability(session.id, [
        'company.contacts',
        'company.contactsAdd',
        'company.contactsEdit',
      ]),
    ]);

  if (userRes.error) throw new Error(userRes.error.message);
  const userRow = userRes.data as UserRow | null;
  if (!userRow) return null;

  // FROZEN ACCOUNT (migration #24) — treated exactly like "no such user", so
  // every caller of this function (every protected page and API route) rejects
  // the request and the guards redirect to /login.
  //
  // Freezing also bumps token_version, which invalidates outstanding JWTs on
  // its own. This check is the belt to that braces: if the bump ever failed,
  // the freeze still takes effect here, on the very next request.
  if (userRow.is_frozen === true) return null;

  const memRows = memRes; // membershipRows already unwrapped and threw on error

  if (compRes.error) throw new Error(compRes.error.message);
  const compRows = (compRes.data as CompanyRow[] | null) ?? [];

  const companyById = new Map<string, CompanyRow>(
    compRows.map((c) => [c.id, c])
  );

  const memberships: Membership[] = [];
  for (const m of memRows) {
    const c = companyById.get(m.company_id);
    if (!c) continue; // orphaned membership (company deleted) — skip defensively
    memberships.push({
      companyId: c.id,
      companyNameEn: c.name_en,
      companyNameAr: c.name_ar,
      role: m.role,
      // undefined (not null) when the column is not in this database yet, so a
      // caller can tell "no role assigned" from "cannot know".
      paylaterRole: m.paylater_role,
    });
  }

  const isAdmin = userRow.is_admin === true;

  const managerCompanyIds = new Set(
    memberships.filter((m) => m.role === 'manager').map((m) => m.companyId)
  );

  // Companies where this person holds a Collections role on the membership.
  const collectionsRoleCompanyIds = new Set(
    memberships.filter((m) => hasCollectionsRole(m.paylaterRole)).map((m) => m.companyId)
  );

  const allCompanies: SwitchableCompany[] = isAdmin
    ? compRows.map((c) => ({
        id: c.id,
        nameEn: c.name_en,
        nameAr: c.name_ar,
        role: 'admin' as const,
        isManager: managerCompanyIds.has(c.id),
        hasFilePermission: permittedCompanyIds.has(c.id),
        hasAttendancePermission: attendancePermittedCompanyIds.has(c.id),
        hasCrmPermission: crmPermittedCompanyIds.has(c.id),
        // An admin opens Collections anywhere, exactly as paylaterAccess'
        // `byRole` does.
        hasCollectionsAccess: true,
      }))
    : memberships.map((m) => ({
        id: m.companyId,
        nameEn: m.companyNameEn,
        nameAr: m.companyNameAr,
        role: m.role,
        isManager: m.role === 'manager',
        hasFilePermission: permittedCompanyIds.has(m.companyId),
        hasAttendancePermission: attendancePermittedCompanyIds.has(m.companyId),
        hasCrmPermission: crmPermittedCompanyIds.has(m.companyId),
        hasCollectionsAccess:
          m.role === 'manager' || collectionsRoleCompanyIds.has(m.companyId),
      }));

  // SINGLE-COMPANY MODE: narrow the switchable/display list to the one pinned
  // company (Ali AlBaker Law Firm) when the flag is set. This hides every other
  // company from the switcher, the overview list, and forces the active company
  // to the pinned one (the shell defaults the active company to companies[0]).
  // `memberships` above is left UNTOUCHED, so all per-company authorization and
  // company_id scoping remain exactly as before — this only ever narrows what
  // is SHOWN, never widens access. Reversible: unset ONLY_COMPANY_NAME_EN.
  const companies = filterToOnlyCompany(allCompanies);

  return {
    userId: userRow.id,
    username: userRow.username,
    fullNameEn: userRow.full_name_en,
    fullNameAr: userRow.full_name_ar,
    isAdmin,
    memberships,
    companies,
  };
}

/**
 * Does this membership's Collections role grant entry?
 *
 * `undefined` means migration #35 has not run, so the column could not be read.
 * That is NOT the same as "no role assigned" and must not grant anything: a
 * read that could not prove access must never hand it out. An admin or manager
 * still gets in on their role, which needs no column at all.
 *
 * Exported so the rule has one home and can be tested directly — it decides
 * whether the Collections link is drawn, and app/collections/guard.ts decides
 * the same question again server-side before anything is shown.
 */
export function hasCollectionsRole(paylaterRole: string | null | undefined): boolean {
  return typeof paylaterRole === 'string' && paylaterRole.length > 0;
}

// ---- Small, pure authorization helpers -------------------------------------

/** Layer 1: global admin has admin-level power over ALL companies. */
export function canAdmin(pu: PlatformUser): boolean {
  return pu.isAdmin;
}

/** The companies the user may switch the active context to. */
export function companiesForUser(pu: PlatformUser): SwitchableCompany[] {
  return pu.companies;
}

/**
 * The caller's effective role IN a specific company:
 *   • admin      → 'admin' for every company (Layer 1)
 *   • otherwise  → their membership role in that company, or null if none.
 * A null result means the company is outside the caller's hard isolation
 * boundary and no company-scoped action is permitted.
 */
export function roleInCompany(
  pu: PlatformUser,
  companyId: string
): 'admin' | MembershipRole | null {
  if (pu.isAdmin) return 'admin';
  const m = pu.memberships.find((x) => x.companyId === companyId);
  return m ? m.role : null;
}

/** True if the user manages at least one company (used for nav/landing). */
export function isManagerAnywhere(pu: PlatformUser): boolean {
  return pu.memberships.some((m) => m.role === 'manager');
}

/**
 * True if the user has been granted an extra file permission in ANY company
 * (lib/platform/permissions.ts). Lets an otherwise-plain employee reach the
 * Folders page even though `reachesAdmin` is false for them — every OTHER
 * admin page still gates on `reachesAdmin` alone, so this never widens
 * access beyond Folders.
 */
export function hasFilePermissionAnywhere(pu: PlatformUser): boolean {
  return pu.companies.some((c) => c.hasFilePermission);
}

/** Same as above, scoped to one specific company. */
export function hasFilePermissionInCompany(
  pu: PlatformUser,
  companyId: string
): boolean {
  return pu.companies.some((c) => c.id === companyId && c.hasFilePermission);
}

/** Same idea as hasFilePermissionAnywhere, but for can_upload_attendance. */
export function hasAttendancePermissionAnywhere(pu: PlatformUser): boolean {
  return pu.companies.some((c) => c.hasAttendancePermission);
}

/** Same as above, scoped to one specific company. */
export function hasAttendancePermissionInCompany(
  pu: PlatformUser,
  companyId: string
): boolean {
  return pu.companies.some((c) => c.id === companyId && c.hasAttendancePermission);
}

/**
 * True if the user holds a MANAGER membership in `companyId`, INDEPENDENT of the
 * global admin flag. This is the "manager operates" gate: creating/assigning
 * tasks requires an actual manager membership, so a PURE global admin (no
 * membership) is refused — enforcing spec §6's "Admin does NOT create tasks".
 * A global admin who is ALSO a manager (Yousef) passes.
 */
export function isManagerOfCompany(
  pu: PlatformUser,
  companyId: string
): boolean {
  return pu.memberships.some(
    (m) => m.companyId === companyId && m.role === 'manager'
  );
}

/**
 * Landing bucket after login: admins and managers get the multi-company admin
 * shell at /admin; everyone else (employees) gets the employee placeholder.
 */
export function reachesAdmin(pu: PlatformUser): boolean {
  return pu.isAdmin || isManagerAnywhere(pu);
}

/** The post-login landing path for a resolved platform user. */
export function landingForPlatformUser(pu: PlatformUser): string {
  return reachesAdmin(pu) ? '/admin' : '/me';
}

/**
 * Server-Component guard: resolve the current session + platform identity or
 * redirect to /login. Use at the top of every protected page.
 */
export async function requirePlatformUser(): Promise<PlatformUser> {
  const session = await getSession();
  if (!session) redirect('/login');
  const pu = await getPlatformUser(session);
  if (!pu) redirect('/login');
  return pu;
}
