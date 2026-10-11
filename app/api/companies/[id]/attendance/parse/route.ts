import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import { canUploadAttendance } from '@/lib/platform/permissions';
import {
  parseAttendanceWorkbook,
  dateRangeOf,
  resolveEmployeeNames,
} from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a time-card export is tiny; reject anything else

/**
 * POST /api/companies/:id/attendance/parse — parse a ZKTeco "Total Time
 * Card" Excel export (multipart/form-data, field "file") WITHOUT storing
 * anything. Returns the detected date range + parsed rows so the uploader
 * can confirm (and correct) the date before committing via .../upload.
 */
export async function POST(
  req: NextRequest,
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'No file was uploaded.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: 'The file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'The file is too large.' }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not read the file.' },
      { status: 400 }
    );
  }

  let rows;
  try {
    rows = parseAttendanceWorkbook(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not parse the file.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'No attendance rows were found in the sheet.' },
      { status: 400 }
    );
  }

  const namesByEmployeeId = await resolveEmployeeNames(
    companyId,
    rows.map((r) => r.employeeId)
  );
  const enrichedRows = rows.map((r) => {
    const match = namesByEmployeeId.get(r.employeeId);
    return {
      ...r,
      nameEn: match?.nameEn ?? null,
      nameAr: match?.nameAr ?? null,
      matched: !!match,
    };
  });

  return NextResponse.json({
    ok: true,
    totalRows: rows.length,
    dateRange: dateRangeOf(rows),
    rows: enrichedRows,
    // Handed back so the COMMIT step can archive the original workbook (see
    // the "Uploaded files" section). Nothing is stored until then, so a
    // cancelled review leaves no orphaned file behind.
    fileName: file.name || 'attendance.xlsx',
    fileBase64: buffer.toString('base64'),
  });
}
