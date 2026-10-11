import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import { getFileById, type PlatformFile } from '@/lib/platform/files';
import { createAccessRequest } from '@/lib/platform/access';
import { canManageFileAccess } from '@/lib/platform/permissions';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/files/:id/access-requests — request to ADD an employee to a file.
 *
 * ADD is hard: this only records a PENDING request (zero capability). A global
 * admin OR a MANAGER of the file's company may request; only an admin approves
 * (separate endpoint). Body: { user_id } — the employee to add, who MUST be an
 * `employee` member of the file's SAME company (cross-company / non-employee →
 * refused). Re-checks authorization server-side; 403 on failure.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
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

  let body: { user_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: 'user_id is required.' },
      { status: 400 }
    );
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(id);
  } catch (err) {
    console.error('Access request (file lookup) error:', err);
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

  // Baseline: a global admin OR a MANAGER of the file's company may request;
  // extendable to an employee explicitly granted can_manage_file_access.
  const role = roleInCompany(pu, file.companyId);
  const isManager = isManagerOfCompany(pu, file.companyId);
  if (
    role !== 'admin' &&
    role !== 'manager' &&
    !(await canManageFileAccess(pu, file.companyId, isManager))
  ) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  try {
    const gate = await gateAction({
      userId: pu.userId,
      companyId: file.companyId,
      capabilityKey: 'files.access.add',
      payload: { fileId: file.id, userId },
      summaryEn: `Add someone to the folder for ${file.clientEn || file.clientAr}`,
      summaryAr: `إضافة شخص إلى مجلد ${file.clientAr || file.clientEn}`,
      isPrivileged: (() => {
        const r = roleInCompany(pu, file.companyId);
        return r === 'admin' || r === 'manager';
      })(),
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await createAccessRequest({
      fileId: file.id,
      companyId: file.companyId,
      userId,
      requestedBy: pu.userId,
    });
    if (!result.ok) {
      if (result.code === 'not_employee') {
        // Cross-company or non-employee target — treat as a bad target (400).
        return NextResponse.json(
          {
            ok: false,
            error: 'That person is not an employee of this company.',
          },
          { status: 400 }
        );
      }
      if (result.code === 'already_member') {
        return NextResponse.json(
          { ok: false, error: 'That employee already has access to this file.' },
          { status: 409 }
        );
      }
      // already_pending
      return NextResponse.json(
        { ok: false, error: 'A request for that employee is already pending.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true, request: result.request }, { status: 201 });
  } catch (err) {
    console.error('Create access request error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
