import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import { canUploadAttendance } from '@/lib/platform/permissions';
import { isDayStatus } from '@/lib/platform/lateness';
import {
  storeAttendanceRows,
  shiftRowDates,
  dateRangeOf,
  datesAlreadyRecorded,
  recordAttendanceUpload,
  finalizeAttendanceUpload,
  objectionApproverId,
  applyAttendanceUpload,
  type SheetRow,
} from '@/lib/platform/attendance';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { canAdmin } from '@/lib/platform/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROWS = 20000; // generous ceiling for a time-card export; guards against abuse

function isValidRow(r: unknown): r is SheetRow {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.employeeId === 'string' &&
    typeof o.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.date) &&
    (o.clockIn === null || typeof o.clockIn === 'string') &&
    (o.clockOut === null || typeof o.clockOut === 'string') &&
    typeof o.lateMinutes === 'number' &&
    typeof o.earlyOutMinutes === 'number' &&
    // Optional; anything unrecognised is rejected rather than silently
    // defaulted, so a typo cannot quietly score a day as present.
    (o.dayStatus === undefined || isDayStatus(o.dayStatus))
  );
}

/** Same whole-day shift shiftRowDates applies, for a single date. */
function shiftIsoDate(date: string, offsetDays: number): string {
  if (offsetDays === 0) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** One objection staged in the review table, keyed by the row it sits on. */
interface RawObjection {
  employeeId: string;
  date: string;
  minutes: number;
  comment: string;
}

function isValidObjection(o: unknown): o is RawObjection {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.employeeId === 'string' &&
    typeof r.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    typeof r.minutes === 'number' &&
    Number.isInteger(r.minutes) &&
    r.minutes > 0 &&
    r.minutes <= 24 * 60 &&
    typeof r.comment === 'string' &&
    r.comment.trim().length > 0 &&
    r.comment.length <= 2000
  );
}

/**
 * POST /api/companies/:id/attendance/upload — commit rows previously
 * returned by .../attendance/parse.
 *
 * Body: { rows, dateOffsetDays?, overwrite?, file?, uploadId?, objections? }
 *
 * dateOffsetDays lets the uploader correct the detected date (every row
 * shifts by the same amount). If any resulting date already has attendance
 * data for this company and `overwrite` isn't explicitly true, nothing is
 * stored — the response asks the caller to confirm the overwrite first.
 *
 * `file` archives the original workbook under a new attendance_uploads row;
 * `uploadId` re-commits into an EXISTING one instead (the edit button on the
 * uploaded-files list), so editing a sheet doesn't spawn a duplicate archive.
 *
 * `objections` are the removals staged on individual rows in the review
 * table. They're created only AFTER the rows are stored — an objection must
 * point at a day that actually exists, at its corrected date.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(b.rows) ? b.rows : null;
  if (!rawRows || rawRows.length === 0 || !rawRows.every(isValidRow)) {
    return NextResponse.json({ ok: false, error: 'Invalid or missing rows.' }, { status: 400 });
  }
  if (rawRows.length > MAX_ROWS) {
    return NextResponse.json({ ok: false, error: 'Too many rows.' }, { status: 400 });
  }
  const dateOffsetDays = typeof b.dateOffsetDays === 'number' ? Math.trunc(b.dateOffsetDays) : 0;
  const overwrite = b.overwrite === true;
  const existingUploadId = typeof b.uploadId === 'string' && b.uploadId ? b.uploadId : null;
  const fileIn = (b.file ?? null) as { name?: unknown; base64?: unknown } | null;
  const fileName =
    fileIn && typeof fileIn.name === 'string' && fileIn.name.trim()
      ? fileIn.name.trim().slice(0, 300)
      : null;
  const fileBase64 =
    fileIn && typeof fileIn.base64 === 'string' && fileIn.base64.length > 0
      ? fileIn.base64
      : null;

  const rawObjections = Array.isArray(b.objections) ? b.objections : [];
  if (!rawObjections.every(isValidObjection)) {
    return NextResponse.json({ ok: false, error: 'Invalid objection.' }, { status: 400 });
  }
  const objections = rawObjections as RawObjection[];

  const rows = shiftRowDates(rawRows, dateOffsetDays);
  // Objections are staged against the row's PRE-shift date (that's what the
  // review table holds), so they follow the same correction the rows do.
  const shiftedObjections = objections.map((o) => ({
    ...o,
    date: shiftIsoDate(o.date, dateOffsetDays),
  }));

  try {
    if (!overwrite) {
      const range = dateRangeOf(rows);
      const existingDates = range
        ? await datesAlreadyRecorded(companyId, Array.from(new Set(rows.map((r) => r.date))))
        : [];
      if (existingDates.length > 0) {
        return NextResponse.json({
          ok: false,
          needsConfirmation: true,
          conflictingDates: existingDates,
        });
      }
    }

    // Objections need a designated approver and the capability to raise them —
    // re-checked here, never trusted from the client that rendered the button.
    let approverId: string | null = null;
    if (shiftedObjections.length > 0) {
      const mayObject =
        canAdmin(pu) ||
        isManager ||
        (await hasCapabilityGrant(pu.userId, companyId, 'attendance.objection'));
      if (!mayObject) {
        return NextResponse.json(
          { ok: false, error: 'You may not raise attendance objections.' },
          { status: 403 }
        );
      }
      approverId = await objectionApproverId(companyId);
      if (!approverId) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'No objection approver has been set for this company. Ask an admin to set one in Company settings.',
          },
          { status: 400 }
        );
      }
    }

    // GATE. The whole import is parked as one action — rows, the archived
    // workbook and any objections together — because applying half of a sheet
    // is not a meaningful state to leave anything in.
    const gate = await gateAction({
      userId: pu.userId,
      companyId,
      capabilityKey: 'attendance.upload',
      payload: {
        rows,
        uploadId: existingUploadId,
        fileName,
        fileBase64,
        objections: shiftedObjections,
        approverId,
        actorNameEn: pu.fullNameEn,
        actorNameAr: pu.fullNameAr,
      },
      summaryEn: `Upload the attendance sheet (${rows.length} rows)`,
      summaryAr: `رفع كشف الحضور (${rows.length} صف)`,
      isPrivileged: canAdmin(pu) || isManager,
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const applied = await applyAttendanceUpload({
      companyId,
      actorId: pu.userId,
      actorNameEn: pu.fullNameEn,
      actorNameAr: pu.fullNameAr,
      rows,
      uploadId: existingUploadId,
      fileName,
      fileBase64,
      objections: shiftedObjections,
      approverId,
    });

    return NextResponse.json({
      ok: true,
      result: applied,
    });
  } catch (err) {
    console.error('Attendance upload (store) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
