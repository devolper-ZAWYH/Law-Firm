import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import {
  canCreateFile,
  canEditFileCore,
  canDeleteFile,
  canMoveFileSection,
  canCreateTaskOnFile,
  canManageFileAccess,
  canUploadAttendance,
} from '@/lib/platform/permissions';
import { getExpandedCapabilities } from '@/lib/platform/capabilityGrants';
import { allCapabilityKeys } from '@/lib/platform/capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/companies/:id/permissions/me — the CALLER's own EFFECTIVE
 * permissions in this company (baseline role rules already folded in, e.g. an
 * admin always gets true for everything except can_create_task — see
 * lib/platform/permissions.ts). The Folders UI uses this to decide which
 * buttons to show, instead of re-deriving baseline rules client-side.
 *
 * Any member of the company (or a global admin) may call this — it only ever
 * describes the CALLER's own access, never another user's.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  const companyId = params.id;
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const isManager = isManagerOfCompany(pu, companyId);
    const [
      canCreate,
      canEdit,
      canDelete,
      canMoveSection,
      canCreateTask,
      canManageAccess,
      canUploadAtt,
      grantedCapabilities,
    ] = await Promise.all([
      canCreateFile(pu, companyId, isManagerOfCompany(pu, companyId)),
      canEditFileCore(pu, companyId),
      canDeleteFile(pu, companyId),
      canMoveFileSection(pu, companyId, isManager),
      canCreateTaskOnFile(pu, companyId, isManager),
      canManageFileAccess(pu, companyId, isManager),
      canUploadAttendance(pu, companyId, isManager),
      getExpandedCapabilities(pu.userId, companyId),
    ]);

    // An admin's baseline already bypasses every capability check (see
    // lib/platform/permissions.ts), so their effective set is "everything in
    // the tree" regardless of what rows exist — mirrors that bypass instead
    // of requiring an admin to also hold explicit grant rows.
    const capabilities = pu.isAdmin
      ? allCapabilityKeys()
      : Array.from(grantedCapabilities);

    return NextResponse.json({
      ok: true,
      permissions: {
        canCreateFile: canCreate,
        canEditFile: canEdit,
        canDeleteFile: canDelete,
        canMoveFileSection: canMoveSection,
        canCreateTask,
        canManageFileAccess: canManageAccess,
        canUploadAttendance: canUploadAtt,
      },
      capabilities,
    });
  } catch (err) {
    console.error('Get my permissions error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
