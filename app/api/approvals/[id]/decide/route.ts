import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, roleInCompany } from '@/lib/platform/auth';
import {
  decideApprovalRequest,
  getApprovalManagerId,
  getApprovalRequest,
} from '@/lib/platform/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/:id/decide — the approving manager decides one held
 * request. Body: { decision: 'approved' | 'rejected', note?: string }.
 *
 * WHO MAY DECIDE. Only the company's ADMIN-ASSIGNED approving manager, or a
 * global admin. Being a manager is not enough: the whole point of the
 * assignment is that the person who hands out a permission does not get to
 * choose who polices its use.
 *
 * On 'approved' the parked action runs before this responds, so a 200 means it
 * actually happened. If the action itself fails (the task was already deleted,
 * the assignee went on leave), the request is recorded as 'failed' with the
 * reason and this returns 409 — the decision stands, the action did not land,
 * and the response says so rather than claiming success.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    return NextResponse.json(
      { ok: false, error: 'Decision must be approved or rejected.' },
      { status: 400 }
    );
  }
  const note =
    typeof body.note === 'string' && body.note.trim().length > 0
      ? body.note.trim().slice(0, 1000)
      : null;

  try {
    const request = await getApprovalRequest(params.id);
    if (!request) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    // Company isolation before anything else: a member of another company must
    // not even learn that this request exists.
    if (roleInCompany(pu, request.companyId) === null) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    const approverId = await getApprovalManagerId(request.companyId);
    if (!canAdmin(pu) && approverId !== pu.userId) {
      return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
    }

    const result = await decideApprovalRequest(params.id, pu.userId, decision, note);
    if (!result.ok) {
      const status =
        result.code === 'not_found' ? 404 : result.code === 'revoked' ? 409 : 409;
      return NextResponse.json(
        { ok: false, code: result.code, error: result.error },
        { status }
      );
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    console.error('Decide approval request error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
