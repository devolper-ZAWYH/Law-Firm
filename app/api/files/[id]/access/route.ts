import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import {
  getFileById,
  isFileAssignedToUser,
  type PlatformFile,
} from '@/lib/platform/files';
import { getFileAccessSnapshot } from '@/lib/platform/access';
import { canManageFileAccess } from '@/lib/platform/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * GET /api/files/:id/access — who is on a file + pending requests + who can be
 * added. Company-isolated: a global admin, or a MANAGER of the file's company.
 * (Employees do not reach the Files UI in Phase 3.) 404 across the isolation
 * boundary so we never confirm a file exists to an outsider.
 *
 * Returns { members, pending, assignableEmployees } (see getFileAccessSnapshot).
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  const id = params.id;
  let file: PlatformFile | null = null;
  try {
    file = await getFileById(id);
  } catch (err) {
    console.error('File access (lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  const role = roleInCompany(pu, file.companyId);
  const isManager = isManagerOfCompany(pu, file.companyId);
  const privileged = role === 'admin' || role === 'manager';

  // TOGETHER, not one after the other. Neither answer feeds the other, and on
  // a database this far away each await is a ~200ms round trip that the next
  // one waits through for no reason. `assigned` is skipped entirely for a
  // manager or admin, for whom it is true by definition.
  const [canManage, assigned] = await Promise.all([
    canManageFileAccess(pu, file.companyId, isManager),
    privileged ? Promise.resolve(true) : isFileAssignedToUser(file.id, pu.userId),
  ]);
  if (!privileged && (!canManage || !assigned)) {
    return NextResponse.json(
      { ok: false, error: 'Not found.' },
      { status: 404 }
    );
  }

  try {
    const snapshot = await getFileAccessSnapshot(file.id, file.companyId);
    // Expose whether THIS caller may add/remove so the client renders controls
    // (the mutating endpoints re-check this server-side regardless).
    return NextResponse.json({ ok: true, ...snapshot, canManage });
  } catch (err) {
    console.error('File access snapshot error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
