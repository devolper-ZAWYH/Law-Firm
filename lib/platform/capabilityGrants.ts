import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import {
  LEGACY_CAPABILITY_MAP,
  expandCapabilities,
  isApprovableCapability,
  isCapabilityKey,
  type CapabilityKey,
} from './capabilities';
import { setMembershipPermissions, type MembershipPermissions } from './permissions';
import { isMissingRelationError } from './schemaCompat';

/**
 * Storage + resolution for the full capability tree (see capabilities.ts),
 * on top of the flat membership_permissions booleans that predate it.
 *
 * ONE ROW PER GRANTED KEY, no expansion applied at write time — checking a
 * parent in the UI still sends only the parent's key. expandCapabilities()
 * derives the rest at read time, so a capability added to the tree later is
 * automatically covered by an existing parent grant, no backfill needed.
 *
 * LEGACY SYNC — the seven actions in LEGACY_CAPABILITY_MAP already have
 * server-side enforcement that reads membership_permissions directly (see
 * lib/platform/permissions.ts). Every write here also derives those seven
 * booleans from the resulting expanded set and upserts membership_permissions,
 * so granting via the tree keeps existing checks working without touching
 * every call site. Capabilities with no legacy counterpart are stored here
 * only.
 */

/** One stored grant row: the key, and whether each use of it must be approved. */
export interface CapabilityGrantRow {
  key: CapabilityKey;
  requiresApproval: boolean;
}

/**
 * Every stored grant for this membership, raw (not expanded), WITH its
 * approval flag.
 *
 * DEPLOY SAFETY: `requires_approval` arrives in migration #30. If this runs
 * against a database that hasn't applied it yet, Postgres answers 42703
 * (undefined column) and we retry without it, treating every grant as ungated
 * — which is exactly the behaviour before the column existed.
 */
export async function getCapabilityGrantRows(
  userId: string,
  companyId: string
): Promise<CapabilityGrantRow[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_capability_grants')
    .select('capability_key, requires_approval')
    .eq('user_id', userId)
    .eq('company_id', companyId);

  if (res.error) {
    if (!isMissingRelationError(res.error)) {
      throw new Error(res.error.message);
    }
    const legacy = await supabase
      .from('membership_capability_grants')
      .select('capability_key')
      .eq('user_id', userId)
      .eq('company_id', companyId);
    if (legacy.error) throw new Error(legacy.error.message);
    return ((legacy.data as { capability_key: string }[] | null) ?? []).map((r) => ({
      key: r.capability_key,
      requiresApproval: false,
    }));
  }

  return (
    (res.data as { capability_key: string; requires_approval: boolean }[] | null) ?? []
  ).map((r) => ({ key: r.capability_key, requiresApproval: r.requires_approval === true }));
}

/** Every stored grant for this membership, raw (not expanded). */
export async function getCapabilityGrants(
  userId: string,
  companyId: string
): Promise<CapabilityKey[]> {
  return (await getCapabilityGrantRows(userId, companyId)).map((r) => r.key);
}

/**
 * Must this membership's use of `needed` be held for an approver?
 *
 * Only meaningful for a capability the membership actually HOLDS — callers
 * check that first (hasCapabilityGrant), then ask this. Baseline managers and
 * admins never reach here: gating applies to a granted capability, not to the
 * authority the role carries on its own.
 *
 * WHICH ROWS DECIDE. A capability can be held through a row that isn't its own
 * key — a granted parent ('files.move' via nothing but 'files.move.active', or
 * the reverse). So we look at every stored row whose expansion covers `needed`,
 * and gate only if EVERY one of them is flagged. One ungated covering grant is
 * an explicit "you may do this outright", and it wins: a stray flag on some
 * sibling leaf must not quietly retract a permission that was given freely.
 */
export async function requiresApprovalFor(
  userId: string,
  companyId: string,
  needed: CapabilityKey
): Promise<boolean> {
  const rows = await getCapabilityGrantRows(userId, companyId);
  const covering = rows.filter((r) => expandCapabilities([r.key]).has(needed));
  if (covering.length === 0) return false;
  return covering.every((r) => r.requiresApproval);
}

/** This membership's grants, expanded (parents imply their children). */
export async function getExpandedCapabilities(
  userId: string,
  companyId: string
): Promise<Set<CapabilityKey>> {
  const raw = await getCapabilityGrants(userId, companyId);
  return expandCapabilities(raw);
}

/**
 * Does this membership hold `needed` — directly, or via a granted ancestor
 * (see expandCapabilities)? For capabilities with no legacy boolean (like
 * tasks.edit / tasks.delete), this tree is the ONLY place the grant lives —
 * a route enforcing one of those must call this rather than the legacy
 * membership_permissions checks in permissions.ts, which cannot see it.
 */
export async function hasCapabilityGrant(
  userId: string,
  companyId: string,
  needed: CapabilityKey
): Promise<boolean> {
  const expanded = await getExpandedCapabilities(userId, companyId);
  return expanded.has(needed);
}

/**
 * Every company id where this user's membership holds `needed` (directly, or
 * via an ancestor/descendant grant — see expandCapabilities), across ALL of
 * their companies. Mirrors companiesWithAnyPermission's shape (used for the
 * legacy 7 flags) but for one arbitrary capability tree key — used to decide
 * page-level access ("does this employee reach the page in ANY company they
 * belong to") for capabilities with no legacy boolean, e.g. tasks.overview.
 */
export async function companiesWithCapability(
  userId: string,
  needed: CapabilityKey
): Promise<Set<string>> {
  return companiesWithAnyCapability(userId, [needed]);
}

/** Same idea as companiesWithCapability, but satisfied by ANY of `needed`. */
export async function companiesWithAnyCapability(
  userId: string,
  needed: CapabilityKey[]
): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_capability_grants')
    .select('company_id, capability_key')
    .eq('user_id', userId);
  if (res.error) {
    // DEPLOY SAFETY: tolerate the table not existing yet rather than 500ing.
    // PostgREST answers PGRST205 for a table missing from its schema cache,
    // which is what actually happens before the migration runs; the raw
    // SQLSTATE 42P01 only surfaces when the statement itself executes.
    if (isMissingRelationError(res.error)) return new Set();
    throw new Error(res.error.message);
  }
  const byCompany = new Map<string, CapabilityKey[]>();
  for (const r of (res.data as
    | { company_id: string; capability_key: string }[]
    | null) ?? []) {
    const list = byCompany.get(r.company_id);
    if (list) list.push(r.capability_key);
    else byCompany.set(r.company_id, [r.capability_key]);
  }
  const out = new Set<string>();
  for (const [companyId, keys] of byCompany) {
    const expanded = expandCapabilities(keys);
    if (needed.some((k) => expanded.has(k))) out.add(companyId);
  }
  return out;
}

/**
 * Every user id, within ONE company, whose membership holds `needed`
 * (directly, or via an ancestor/descendant grant). The company-scoped
 * counterpart of companiesWithCapability — used to widen a notification
 * recipient list (e.g. "everyone granted notifications.overdue") rather than
 * to decide one user's own access.
 */
export async function companyMembersWithCapability(
  companyId: string,
  needed: CapabilityKey
): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_capability_grants')
    .select('user_id, capability_key')
    .eq('company_id', companyId);
  if (res.error) {
    // DEPLOY SAFETY: see companiesWithAnyCapability above.
    if (isMissingRelationError(res.error)) return [];
    throw new Error(res.error.message);
  }
  const byUser = new Map<string, CapabilityKey[]>();
  for (const r of (res.data as
    | { user_id: string; capability_key: string }[]
    | null) ?? []) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r.capability_key);
    else byUser.set(r.user_id, [r.capability_key]);
  }
  const out: string[] = [];
  for (const [userId, keys] of byUser) {
    if (expandCapabilities(keys).has(needed)) out.push(userId);
  }
  return out;
}

/** Does this membership hold ANY of `needed` (each checked the same way as hasCapabilityGrant)? */
export async function hasAnyCapabilityGrant(
  userId: string,
  companyId: string,
  needed: CapabilityKey[]
): Promise<boolean> {
  const expanded = await getExpandedCapabilities(userId, companyId);
  return needed.some((k) => expanded.has(k));
}

function legacyPatchFor(expanded: Set<CapabilityKey>): Partial<MembershipPermissions> {
  const patch: Partial<MembershipPermissions> = {};
  for (const [legacyCol, capKey] of Object.entries(LEGACY_CAPABILITY_MAP)) {
    const field = LEGACY_FIELD_BY_COLUMN[legacyCol];
    if (field) patch[field] = expanded.has(capKey);
  }
  return patch;
}

/** can_create_file → canCreateFile, etc. — mirrors mapRow() in permissions.ts. */
const LEGACY_FIELD_BY_COLUMN: Record<string, keyof MembershipPermissions> = {
  can_create_file: 'canCreateFile',
  can_edit_file: 'canEditFile',
  can_delete_file: 'canDeleteFile',
  can_move_file_section: 'canMoveFileSection',
  can_create_task: 'canCreateTask',
  can_manage_file_access: 'canManageFileAccess',
  can_upload_attendance: 'canUploadAttendance',
};

/**
 * Replace this membership's ENTIRE grant set with `keys` (unknown/invalid keys
 * are dropped silently — the caller is expected to have validated already).
 * Also re-syncs the seven legacy booleans (see file header). Returns the
 * stored (raw) keys.
 *
 * `approvalKeys` are the subset of `keys` whose every use must be signed off by
 * the company's approving manager. A key not in that subset is stored ungated,
 * so omitting the argument entirely reproduces the pre-approval behaviour.
 * Keys that cannot be gated (no executor — see APPROVAL_ACTION_BY_CAPABILITY)
 * are ignored rather than stored as a flag nothing reads.
 */
export async function setCapabilityGrants(
  userId: string,
  companyId: string,
  keys: CapabilityKey[],
  grantedBy: string,
  approvalKeys: CapabilityKey[] = []
): Promise<CapabilityKey[]> {
  const valid = Array.from(new Set(keys.filter(isCapabilityKey)));
  const gated = new Set(
    approvalKeys.filter((k) => isCapabilityKey(k) && isApprovableCapability(k))
  );
  const supabase = getSupabaseAdmin();

  const del = await supabase
    .from('membership_capability_grants')
    .delete()
    .eq('user_id', userId)
    .eq('company_id', companyId);
  if (del.error) throw new Error(del.error.message);

  if (valid.length > 0) {
    const rows = valid.map((capability_key) => ({
      user_id: userId,
      company_id: companyId,
      capability_key,
      granted_by: grantedBy,
      requires_approval: gated.has(capability_key),
    }));
    const ins = await supabase.from('membership_capability_grants').insert(rows);
    if (ins.error) {
      // DEPLOY SAFETY: pre-migration-#30 database has no requires_approval
      // column. Store the grants themselves rather than failing the whole save
      // — they are the part that works without the new column.
      if (!isMissingRelationError(ins.error)) {
        throw new Error(ins.error.message);
      }
      const retry = await supabase.from('membership_capability_grants').insert(
        rows.map(({ requires_approval: _drop, ...rest }) => rest)
      );
      if (retry.error) throw new Error(retry.error.message);
    }
  }

  const expanded = expandCapabilities(valid);
  await setMembershipPermissions(userId, companyId, legacyPatchFor(expanded));

  return valid;
}
