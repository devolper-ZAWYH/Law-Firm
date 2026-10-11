import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import { canUploadAttendance } from '@/lib/platform/permissions';
import { listAttendanceUploads } from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/companies/:id/attendance/uploads — every attendance file archived
 * for this company, newest first (metadata only; the bytes come from the
 * /file sub-route one at a time).
 *
 * Gated on the SAME permission as uploading: these files are the raw record of
 * everyone's attendance, so whoever may put one in may see, re-edit and
 * remove them, and nobody else.
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
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const isManager = isManagerOfCompany(pu, companyId);
  if (!(await canUploadAttendance(pu, companyId, isManager))) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const uploads = await listAttendanceUploads(companyId);
    return NextResponse.json({ ok: true, uploads });
  } catch (err) {
    console.error('List attendance uploads error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
