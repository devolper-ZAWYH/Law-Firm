import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import { getPlatformUser, canAdmin, isManagerOfCompany, roleInCompany } from '@/lib/platform/auth';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { listLeavePeriods, createLeavePeriod, todayIso } from '@/lib/platform/leave';
import { notifyAssigneeOnLeave } from '@/lib/platform/alerts';
import type { PlatformUser } from '@/lib/platform/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Booked employee leave for one company.
 *
 * Admin, a manager of the company, or an employee granted 'attendance.leave'.
 * That grant does NOT imply any other attendance access — the sheet upload and
 * the company-wide summary stay behind their own keys.
 */
async function authorize(
  companyId: string
): Promise<{ pu: PlatformUser; error?: undefined } | { pu?: undefined; error: NextResponse }> {
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return {
      error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, companyId) &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'attendance.leave'))
  ) {
    return {
      error: NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 }),
    };
  }
  return { pu };
}

/** GET — current and upcoming periods (anything not yet finished). */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  try {
    const periods = await listLeavePeriods(params.id, { from: todayIso() });
    return NextResponse.json({ ok: true, periods });
  } catch (err) {
    console.error('Leave list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** POST — book leave. Body: { user_id, start_date, end_date, note? }. */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  const pu = auth.pu;

  let body: {
    user_id?: unknown;
    start_date?: unknown;
    end_date?: unknown;
    note?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const startDate = typeof body.start_date === 'string' ? body.start_date.trim() : '';
  const endDate = typeof body.end_date === 'string' ? body.end_date.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!userId || !ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return NextResponse.json(
      { ok: false, error: 'An employee, a start date and an end date are required.' },
      { status: 400 }
    );
  }
  if (endDate < startDate) {
    return NextResponse.json(
      { ok: false, error: 'The end date cannot be before the start date.' },
      { status: 400 }
    );
  }

  try {
    const gate = await gateAction({
      userId: pu.userId,
      companyId: params.id,
      capabilityKey: 'attendance.leave',
      payload: {
        userId,
        startDate,
        endDate,
        note: note.length > 0 ? note : null,
      },
      summaryEn: `Book leave from ${startDate} to ${endDate}`,
      summaryAr: `تسجيل إجازة من ${startDate} إلى ${endDate}`,
      isPrivileged: (() => {
        const r = roleInCompany(pu, params.id);
        return r === 'admin' || r === 'manager';
      })(),
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await createLeavePeriod({
      companyId: params.id,
      userId,
      startDate,
      endDate,
      note: note.length > 0 ? note : null,
      createdBy: pu.userId,
    });
    if (!result.ok) {
      if (result.code === 'overlap') {
        return NextResponse.json(
          { ok: false, error: 'This person already has leave booked over those dates.' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'An employee, a start date and an end date are required.' },
        { status: 400 }
      );
    }
    // Tell the approver of every open task this person is holding, so the work
    // can be reassigned. Leave does not pause the task clock, so this notice is
    // the whole mechanism by which the work gets picked up. Best-effort — a
    // failed notification must not undo the booking that already succeeded.
    try {
      await notifyAssigneeOnLeave(result.period);
    } catch (notifyErr) {
      console.error('notifyAssigneeOnLeave failed:', notifyErr);
    }
    return NextResponse.json({ ok: true, period: result.period }, { status: 201 });
  } catch (err) {
    console.error('Leave create error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
