import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { listPendingObjections, objectionApproverId } from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/companies/:id/attendance/objections — the objections still awaiting
 * a decision.
 *
 * ONLY the company's designated approver may read this. Not admins, not other
 * managers: the whole point of the setting is that exactly one person is
 * accountable for these decisions, and the list names employees alongside
 * their disputed lateness.
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
  if (!pu || roleInCompany(pu, params.id) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const approverId = await objectionApproverId(params.id);
    if (!approverId || approverId !== pu.userId) {
      // Not an error — the Attendance page asks every visitor and simply
      // renders nothing when they aren't the approver.
      return NextResponse.json({ ok: true, isApprover: false, objections: [] });
    }
    const objections = await listPendingObjections(params.id);
    return NextResponse.json({ ok: true, isApprover: true, objections });
  } catch (err) {
    console.error('List attendance objections error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
