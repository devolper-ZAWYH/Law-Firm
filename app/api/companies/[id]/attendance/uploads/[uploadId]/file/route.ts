import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import { canUploadAttendance } from '@/lib/platform/permissions';
import { getAttendanceUploadFile } from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/companies/:id/attendance/uploads/:uploadId/file — download the
 * original workbook exactly as it was uploaded.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; uploadId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu || roleInCompany(pu, params.id) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const isManager = isManagerOfCompany(pu, params.id);
  if (!(await canUploadAttendance(pu, params.id, isManager))) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const file = await getAttendanceUploadFile(params.id, params.uploadId);
    if (!file) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    // The filename is user-supplied: strip quotes/newlines so it cannot break
    // out of the Content-Disposition header.
    const safeName = file.fileName.replace(/["\r\n\\]/g, '_');
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': String(file.buffer.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Download attendance upload error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
