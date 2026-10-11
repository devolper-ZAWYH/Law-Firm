import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { decideObjection, objectionApproverId } from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/companies/:id/attendance/objections/:objectionId — { approve:
 * boolean }. Approving removes the requested minutes from that day (they stop
 * counting as late/early-out); rejecting keeps the minutes as recorded.
 *
 * ONLY the company's designated approver may decide, re-read from the company
 * row on every call — reassigning the approver in settings takes effect
 * immediately, including for objections raised under the previous one.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; objectionId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu || roleInCompany(pu, params.id) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  let body: { approve?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  if (typeof body.approve !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  try {
    const approverId = await objectionApproverId(params.id);
    if (!approverId || approverId !== pu.userId) {
      return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
    }
    const outcome = await decideObjection({
      companyId: params.id,
      objectionId: params.objectionId,
      deciderId: pu.userId,
      approve: body.approve,
    });
    if (outcome === 'not-found') {
      return NextResponse.json(
        { ok: false, error: 'This objection has already been decided.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Decide attendance objection error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
