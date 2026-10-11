import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  canAdmin,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import {
  attendanceSummaryForCompany,
  currentAttendancePeriod,
} from '@/lib/platform/attendance';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/companies/:id/attendance/summary — per-employee total late /
 * early-out minutes for the CURRENT period (25th→24th), for one company.
 *
 * Admin, manager, or an employee explicitly granted 'attendance.viewAll' —
 * anyone else (even the one designated to upload the sheet) never sees
 * anyone's attendance but their own; that's served separately by
 * GET /api/attendance/me.
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
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, companyId) &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'attendance.viewAll'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const summary = await attendanceSummaryForCompany(companyId);
    const period = currentAttendancePeriod();
    return NextResponse.json({ ok: true, summary, period });
  } catch (err) {
    console.error('Attendance summary error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
