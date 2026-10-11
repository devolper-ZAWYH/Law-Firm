import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import { getFileById, type PlatformFile } from '@/lib/platform/files';
import { removeFileAccess } from '@/lib/platform/access';
import { canManageFileAccess } from '@/lib/platform/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string; userId: string } };

/**
 * DELETE /api/files/:id/access/:userId — remove an employee from a file.
 *
 * REMOVE is easy: a global admin OR a MANAGER of the file's company, no approval.
 * Optional body { reassignTo } — a user_id who MUST already be on the file; it is
 * where the removed person's OPEN tasks will move once tasks exist (Phase 4).
 * RULES enforced in the data layer:
 *   • LAST-PERSON GUARD → 409 if this is the only assignee.
 *   • reassignTo not on the file (or == the person leaving) → 400.
 * Re-checks authorization server-side; 403 on failure.
 */
export async function DELETE(req: NextRequest, { params }: RouteContext) {
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
  const userId = params.userId;

  // Body is OPTIONAL (a plain remove sends none). Parse leniently.
  let reassignTo: string | null = null;
  try {
    const raw = await req.text();
    if (raw && raw.trim().length > 0) {
      const body = JSON.parse(raw) as { reassignTo?: unknown };
      if (typeof body.reassignTo === 'string' && body.reassignTo.trim()) {
        reassignTo = body.reassignTo.trim();
      }
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(id);
  } catch (err) {
    console.error('Remove access (file lookup) error:', err);
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
      capabilityKey: 'files.access.remove',
      payload: { fileId: file.id, userId: params.userId, reassignTo },
      summaryEn: `Remove someone from the folder for ${file.clientEn || file.clientAr}`,
      summaryAr: `إزالة شخص من مجلد ${file.clientAr || file.clientEn}`,
      isPrivileged: (() => {
        const r = roleInCompany(pu, file.companyId);
        return r === 'admin' || r === 'manager';
      })(),
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await removeFileAccess({
      fileId: file.id,
      userId,
      actorId: pu.userId,
      reassignTo,
    });
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'That employee is not on this file.' },
          { status: 404 }
        );
      }
      if (result.code === 'last_person') {
        return NextResponse.json(
          {
            ok: false,
            code: 'last_person',
            error: 'Add another employee first / أضف موظفًا آخر أولاً',
          },
          { status: 409 }
        );
      }
      if (result.code === 'reassign_required') {
        // The employee still owns unfinished tasks; the client must pick who
        // inherits them (another employee already on the file) and re-submit.
        return NextResponse.json(
          {
            ok: false,
            code: 'reassign_required',
            error:
              'This employee has open tasks. Choose who takes them over. / لدى هذا الموظف مهام مفتوحة. اختر من يستلمها.',
          },
          { status: 409 }
        );
      }
      // bad_reassign
      return NextResponse.json(
        {
          ok: false,
          error: 'The replacement must already be on this file.',
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Remove access error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
