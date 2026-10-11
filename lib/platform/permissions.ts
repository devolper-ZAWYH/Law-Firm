import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import type { PlatformUser } from './auth';

/**
 * Per-employee, per-company EXTRA permissions (membership_permissions table).
 *
 * THE MODEL — these flags only ever ADD capability to an 'employee'
 * membership; they never take anything away from a manager or admin, who
 * already have their existing baseline access. Each of the six actions below
 * has its own baseline (who could already do it before this feature existed)
 * — the permission flag is checked ONLY as an extra allowance on top of that
 * baseline, never as a replacement for it.
 *
 *   action                  | baseline (unchanged)      | flag extends it to
 *   ------------------------|----------------------------|--------------------
 *   create a folder         | admin only                 | any grantee
 *   edit a folder's core info | admin only                | any grantee
 *   delete a folder         | admin only                 | any grantee
 *   move a folder's section | admin or manager-of-company| any grantee
 *   create a task on a folder | admin or manager-of-company | any grantee
 *   manage a folder's access | admin or manager-of-company | any grantee
 *   upload the attendance sheet | admin or manager-of-company | any grantee
 */

export interface MembershipPermissions {
  canCreateFile: boolean;
  canEditFile: boolean;
  canDeleteFile: boolean;
  canMoveFileSection: boolean;
  canCreateTask: boolean;
  canManageFileAccess: boolean;
  canUploadAttendance: boolean;
}

const NO_PERMISSIONS: MembershipPermissions = {
  canCreateFile: false,
  canEditFile: false,
  canDeleteFile: false,
  canMoveFileSection: false,
  canCreateTask: false,
  canManageFileAccess: false,
  canUploadAttendance: false,
};

interface PermissionRow {
  user_id: string;
  company_id: string;
  can_create_file: boolean;
  can_edit_file: boolean;
  can_delete_file: boolean;
  can_move_file_section: boolean;
  can_create_task: boolean;
  can_manage_file_access: boolean;
  can_upload_attendance: boolean;
}

function mapRow(row: PermissionRow): MembershipPermissions {
  return {
    canCreateFile: row.can_create_file,
    canEditFile: row.can_edit_file,
    canDeleteFile: row.can_delete_file,
    canMoveFileSection: row.can_move_file_section,
    canCreateTask: row.can_create_task,
    canManageFileAccess: row.can_manage_file_access,
    canUploadAttendance: row.can_upload_attendance,
  };
}

/**
 * Every company id where this user has been granted AT LEAST ONE of the six
 * legacy FOLDER permissions, OR any capability under the 'files.' / 'tasks.'
 * groups of the capability tree (excludes can_upload_attendance and
 * 'attendance.*' on purpose — those gate the separate Attendance page, not
 * Folders). The capability-tree half matters because some Folders-scoped
 * capabilities — e.g. 'tasks.edit' / 'tasks.delete' — have NO legacy boolean
 * counterpart (see LEGACY_CAPABILITY_MAP in capabilities.ts): a membership
 * granted ONLY 'tasks.edit' must still reach the Folders page to use it, even
 * though none of the six legacy columns are set. Used to decide nav/page
 * access for an otherwise-plain employee — this file avoids importing
 * capabilities.ts's tree-walking helpers so lib/platform/auth.ts can import
 * just this without a real module cycle; the 'files.'/'tasks.' prefix check
 * is an inlined equivalent of "is this key under one of those two groups".
 */
export async function companiesWithAnyPermission(
  userId: string
): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const [legacyRes, grantRes] = await Promise.all([
    supabase
      .from('membership_permissions')
      .select('company_id')
      .eq('user_id', userId)
      .or(
        'can_create_file.eq.true,can_edit_file.eq.true,can_delete_file.eq.true,can_move_file_section.eq.true,can_create_task.eq.true,can_manage_file_access.eq.true'
      ),
    supabase
      .from('membership_capability_grants')
      .select('company_id, capability_key')
      .eq('user_id', userId),
  ]);
  if (legacyRes.error) throw new Error(legacyRes.error.message);
  const out = new Set(
    ((legacyRes.data as { company_id: string }[] | null) ?? []).map(
      (r) => r.company_id
    )
  );
  // DEPLOY SAFETY: the capability-grants table is newer than this function —
  // tolerate it not existing yet (42P01) rather than 500-ing every page load.
  if (grantRes.error) {
    if ((grantRes.error as { code?: string }).code !== '42P01') {
      throw new Error(grantRes.error.message);
    }
  } else {
    for (const r of (grantRes.data as
      | { company_id: string; capability_key: string }[]
      | null) ?? []) {
      if (
        r.capability_key.startsWith('files.') ||
        r.capability_key.startsWith('tasks.')
      ) {
        out.add(r.company_id);
      }
    }
  }
  return out;
}

/** Same idea, but for can_upload_attendance specifically (gates the Attendance page). */
export async function companiesWithAttendanceUploadPermission(
  userId: string
): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_permissions')
    .select('company_id')
    .eq('user_id', userId)
    .eq('can_upload_attendance', true);
  if (res.error) throw new Error(res.error.message);
  return new Set(
    ((res.data as { company_id: string }[] | null) ?? []).map((r) => r.company_id)
  );
}

/** One membership's extra permissions, or all-false if never granted. */
export async function getMembershipPermissions(
  userId: string,
  companyId: string
): Promise<MembershipPermissions> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('membership_permissions')
    .select(
      'user_id, company_id, can_create_file, can_edit_file, can_delete_file, can_move_file_section, can_create_task, can_manage_file_access, can_upload_attendance'
    )
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as PermissionRow | null;
  return row ? mapRow(row) : NO_PERMISSIONS;
}

/** Upsert (admin/manager only, enforced by the caller) one membership's flags. */
export async function setMembershipPermissions(
  userId: string,
  companyId: string,
  patch: Partial<MembershipPermissions>
): Promise<MembershipPermissions> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, boolean> = {};
  if (patch.canCreateFile !== undefined) update.can_create_file = patch.canCreateFile;
  if (patch.canEditFile !== undefined) update.can_edit_file = patch.canEditFile;
  if (patch.canDeleteFile !== undefined) update.can_delete_file = patch.canDeleteFile;
  if (patch.canMoveFileSection !== undefined)
    update.can_move_file_section = patch.canMoveFileSection;
  if (patch.canCreateTask !== undefined) update.can_create_task = patch.canCreateTask;
  if (patch.canManageFileAccess !== undefined)
    update.can_manage_file_access = patch.canManageFileAccess;
  if (patch.canUploadAttendance !== undefined)
    update.can_upload_attendance = patch.canUploadAttendance;

  const res = await supabase
    .from('membership_permissions')
    .upsert(
      { user_id: userId, company_id: companyId, ...update, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,company_id' }
    )
    .select(
      'user_id, company_id, can_create_file, can_edit_file, can_delete_file, can_move_file_section, can_create_task, can_manage_file_access, can_upload_attendance'
    )
    .single();
  if (res.error) throw new Error(res.error.message);
  return mapRow(res.data as PermissionRow);
}

// ---- Capability checks (baseline OR granted flag) --------------------------
// Each takes the already-resolved PlatformUser so the common admin case never
// needs a DB round trip.

async function granted(
  pu: PlatformUser,
  companyId: string,
  flag: keyof MembershipPermissions
): Promise<boolean> {
  const perms = await getMembershipPermissions(pu.userId, companyId);
  return perms[flag];
}

/**
 * `isManagerOfCompany` is passed IN rather than looked up here — auth.ts
 * imports this module, so importing it back would make a cycle. Same
 * convention as canMoveFileSection and canCreateTaskOnFile.
 *
 * MANAGERS were missing: this checked only isAdmin plus the legacy flag, so a
 * manager could not create a folder in their own company while being able to
 * move, edit and delete one. The same omission canCreateTaskOnFile had.
 */
export async function canCreateFile(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany = false
): Promise<boolean> {
  if (pu.isAdmin || isManagerOfCompany) return true;
  return granted(pu, companyId, 'canCreateFile');
}

export async function canEditFileCore(pu: PlatformUser, companyId: string): Promise<boolean> {
  if (pu.isAdmin) return true;
  return granted(pu, companyId, 'canEditFile');
}

/**
 * May this person set a folder's CASE NUMBER, COURT and LEVEL?
 *
 * Wider than canEditFileCore on purpose. Recording the case number is clerical
 * — it is the first thing anyone needs on a matter — whereas changing the
 * client or the opponent rewrites what the matter IS. So a MANAGER gets these
 * three fields without also getting the rest, and an employee can be granted
 * exactly them via 'files.caseDetails'.
 *
 * Anyone who may edit the folder outright may of course also set them.
 */
// `hasCaseDetailsGrant` is passed IN rather than looked up here: capabilityGrants.ts
// already imports this module, so importing it back would make a cycle. Same
// convention as isManagerOfCompany above.
export async function canEditCaseDetails(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany: boolean,
  hasCaseDetailsGrant: boolean
): Promise<boolean> {
  if (pu.isAdmin || isManagerOfCompany || hasCaseDetailsGrant) return true;
  return canEditFileCore(pu, companyId);
}

export async function canDeleteFile(pu: PlatformUser, companyId: string): Promise<boolean> {
  if (pu.isAdmin) return true;
  return granted(pu, companyId, 'canDeleteFile');
}

export async function canMoveFileSection(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany: boolean
): Promise<boolean> {
  if (pu.isAdmin || isManagerOfCompany) return true;
  return granted(pu, companyId, 'canMoveFileSection');
}

/**
 * NOTE: unlike the other checks here, a pure global admin (no manager
 * membership) is NOT granted a bypass — "Admin does NOT create tasks" is a
 * deliberate business rule (see app/api/files/[id]/tasks/route.ts). Only an
 * actual manager membership, or an explicit can_create_task grant, qualifies.
 */
export async function canCreateTaskOnFile(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany: boolean
): Promise<boolean> {
  // pu.isAdmin was missing here — the ONLY permission check in this file that
  // omitted it. A global admin who did not also hold a manager membership in
  // the company could not create a task at all, in the UI or through the API,
  // while still being able to edit, push back, delete and reassign one. Found
  // by trying it as an admin against a real folder.
  if (pu.isAdmin || isManagerOfCompany) return true;
  return granted(pu, companyId, 'canCreateTask');
}

export async function canManageFileAccess(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany: boolean
): Promise<boolean> {
  if (pu.isAdmin || isManagerOfCompany) return true;
  return granted(pu, companyId, 'canManageFileAccess');
}

export async function canUploadAttendance(
  pu: PlatformUser,
  companyId: string,
  isManagerOfCompany: boolean
): Promise<boolean> {
  if (pu.isAdmin || isManagerOfCompany) return true;
  return granted(pu, companyId, 'canUploadAttendance');
}
