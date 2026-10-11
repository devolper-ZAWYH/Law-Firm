import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, isManagerOfCompany } from '@/lib/platform/auth';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { deleteLeavePeriod } from '@/lib/platform/leave';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string; leaveId: string } };

/**
 * DELETE /api/companies/:id/leave/:leaveId — cancel booked leave.
 *
 * Same gate as booking it. Company-scoped in the service layer, so a leaveId
 * belonging to another company is simply not found rather than removed.
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, params.id) &&
    !(await hasCapabilityGrant(pu.userId, params.id, 'attendance.leave'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const removed = await deleteLeavePeriod(params.leaveId, params.id);
    if (!removed) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Leave delete error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
