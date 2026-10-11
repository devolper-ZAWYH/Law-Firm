import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  canAdmin,
  isManagerAnywhere,
  isManagerOfCompany,
  roleInCompany,
} from '@/lib/platform/auth';
import { listFolderTypes, createFolderType } from '@/lib/platform/folderTypes';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import { companiesWithCapability } from '@/lib/platform/capabilityGrants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/folder-types — the full folder-type list (built-in + custom).
 * GLOBAL, not company-scoped: any authenticated platform member may read it
 * (needed just to populate the create/edit-file folder-type dropdown).
 */
export async function GET() {
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

  try {
    const folderTypes = await listFolderTypes();
    return NextResponse.json({ ok: true, folderTypes });
  } catch (err) {
    console.error('List folder types error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/folder-types — add a new folder type. Admin OR manager (of any
 * company — the list is global, so a manager membership anywhere qualifies),
 * OR an employee granted 'company.folderTypes' in at least one company.
 * Body: label_en, label_ar, layout ('case' | 'contract').
 */
export async function POST(req: NextRequest) {
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
  if (!canAdmin(pu) && !isManagerAnywhere(pu)) {
    const granted = await companiesWithCapability(pu.userId, 'company.folderTypes');
    if (granted.size === 0) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }
  }

  let body: {
    label_en?: unknown;
    label_ar?: unknown;
    layout?: unknown;
    company_id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  const labelEn =
    typeof body.label_en === 'string' ? body.label_en.trim() : '';
  const labelAr =
    typeof body.label_ar === 'string' ? body.label_ar.trim() : '';
  const layout = body.layout === 'contract' ? 'contract' : 'case';

  if (!labelEn || !labelAr) {
    return NextResponse.json(
      { ok: false, error: 'An English and Arabic label are required.' },
      { status: 400 }
    );
  }

  // The approval gate is per-company. Without a company in context there is no
  // grant to be gated on either, so the action proceeds as before.
  const gateCompanyId =
    typeof body.company_id === 'string' && roleInCompany(pu, body.company_id) !== null
      ? body.company_id
      : null;

  try {
    if (gateCompanyId) {
      const gate = await gateAction({
        userId: pu.userId,
        companyId: gateCompanyId,
        capabilityKey: 'company.folderTypes',
        payload: { labelEn, labelAr, layout },
        summaryEn: `Add the folder type “${labelEn}”`,
        summaryAr: `إضافة نوع المجلد «${labelEn}»`,
        isPrivileged: canAdmin(pu) || isManagerOfCompany(pu, gateCompanyId),
      });
      if (gate.kind === 'no_approver') return noApproverResponse();
      if (gate.kind === 'held') return heldResponse(gate.request.id);
    }

    const folderType = await createFolderType({
      labelEn,
      labelAr,
      layout,
      createdBy: pu.userId,
    });
    return NextResponse.json({ ok: true, folderType }, { status: 201 });
  } catch (err) {
    console.error('Create folder type error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
