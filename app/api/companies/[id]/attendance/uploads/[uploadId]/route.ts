import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany, isManagerOfCompany } from '@/lib/platform/auth';
import { canUploadAttendance } from '@/lib/platform/permissions';
import {
  attendanceUploadRowsForEdit,
  deleteAttendanceUpload,
} from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shared gate: only someone who may upload the sheet may inspect or remove
 * a past upload (see the list route for why). */
async function authorize(companyId: string) {
  const session = await getSession();
  if (!session) return null;
  const pu = await getPlatformUser(session);
  if (!pu) return null;
  if (roleInCompany(pu, companyId) === null) return null;
  const isManager = isManagerOfCompany(pu, companyId);
  if (!(await canUploadAttendance(pu, companyId, isManager))) return null;
  return pu;
}

/**
 * GET — the days this upload stored, shaped like freshly-parsed sheet rows so
 * the review table can edit them. Reads back the STORED records (including any
 * earlier corrections), not the original workbook.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; uploadId: string } }
) {
  const pu = await authorize(params.id);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const data = await attendanceUploadRowsForEdit(params.id, params.uploadId);
    if (!data) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, rows: data.rows, dateRange: data.dateRange });
  } catch (err) {
    console.error('Load attendance upload error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** DELETE — remove the archived file AND the attendance days it stored. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; uploadId: string } }
) {
  const pu = await authorize(params.id);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const ok = await deleteAttendanceUpload(params.id, params.uploadId);
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete attendance upload error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
