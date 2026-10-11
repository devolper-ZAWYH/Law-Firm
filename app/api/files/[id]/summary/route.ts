import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { getFileById, isFileAssignedToUser } from '@/lib/platform/files';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { getFileSummary, saveFileSummary } from '@/lib/platform/fileSummary';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * The folder's one standing summary.
 *
 * READ  — anyone who can already see the folder: admin, a manager of its
 *         company, or an employee assigned to it. The summary describes a
 *         matter they are working on; withholding it from them would be odd.
 * WRITE — admin, a manager, or an employee granted 'files.summary'. That grant
 *         alone confers nothing else, and never write access to another
 *         company's folders (the company check below is the boundary).
 */
async function resolve(taskFileId: string, lang: 'en' | 'ar') {
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return {
      error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  const file = await getFileById(taskFileId);
  if (!file) {
    return { error: NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 }) };
  }

  const role = roleInCompany(pu, file.companyId);
  const isManagerOrAdmin = role === 'admin' || role === 'manager';
  const onFile = await isFileAssignedToUser(file.id, pu.userId);
  if (!isManagerOrAdmin && !onFile) {
    // 404 across the isolation boundary, as everywhere else in this codebase.
    return { error: NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 }) };
  }

  const canWrite =
    isManagerOrAdmin ||
    (await hasCapabilityGrant(pu.userId, file.companyId, 'files.summary'));

  return { pu, file, canWrite, lang };
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const lang = req.nextUrl.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
  try {
    const r = await resolve(params.id, lang);
    if (r.error) return r.error;
    const summary = await getFileSummary(r.file!.id, lang);
    return NextResponse.json({ ok: true, summary, canWrite: r.canWrite });
  } catch (err) {
    console.error('File summary read error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** PUT — create the summary the first time, replace its body thereafter. */
export async function PUT(req: NextRequest, { params }: RouteContext) {
  let body: { body?: unknown; lang?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const lang = body.lang === 'ar' ? 'ar' : 'en';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  // Validated at the boundary, as every other write route here does, rather
  // than relying on the service to reject it.
  if (!text) {
    return NextResponse.json(
      { ok: false, error: 'The summary cannot be empty.' },
      { status: 400 }
    );
  }

  try {
    const r = await resolve(params.id, lang);
    if (r.error) return r.error;
    if (!r.canWrite) {
      return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
    }
    const gate = await gateAction({
      userId: r.pu!.userId,
      companyId: r.file!.companyId,
      capabilityKey: 'files.summary',
      payload: { fileId: r.file!.id, body: text, lang },
      summaryEn: `Update the folder summary for ${r.file!.clientEn || r.file!.clientAr}`,
      summaryAr: `تحديث ملخص مجلد ${r.file!.clientAr || r.file!.clientEn}`,
      isPrivileged:
        roleInCompany(r.pu!, r.file!.companyId) === 'admin' ||
        roleInCompany(r.pu!, r.file!.companyId) === 'manager',
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await saveFileSummary({
      fileId: r.file!.id,
      body: text,
      actorId: r.pu!.userId,
      lang,
    });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: 'The summary cannot be empty.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (err) {
    console.error('File summary write error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
