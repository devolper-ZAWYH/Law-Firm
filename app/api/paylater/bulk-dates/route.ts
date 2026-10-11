import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import { listAssignableMembers } from '@/lib/platform/paylater';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A plain ISO date, or nothing. Anything else is refused rather than coerced. */
function isoDate(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : v;
}

/**
 * POST /api/paylater/bulk-dates — the Team Leader's division of the batch.
 *
 * Applies the notice date, the case registration date, and/or WHO THE FILES
 * BELONG TO across a selection. All three are the same decision in the journey:
 * step 2 divides the batches among the employees, step 3 assigns the notice
 * date, and step 7 has "the employee responsible for the relevant batch" send
 * them. Doing it in one write means a batch is never half-divided.
 *
 * This is a LEAD action (managers and admins override).
 *
 * The update is scoped by company_id as well as by id, so a caller cannot reach
 * another company's rows by supplying their ids — the ids come from the client
 * and are therefore not trusted.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canLead) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let body: {
    ids?: unknown;
    noticePlanned?: unknown;
    caseRegDate?: unknown;
    assignedTo?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: 'Nothing selected.' }, { status: 400 });
  }
  // A generous ceiling that still bounds one request. The largest batch is 100.
  if (ids.length > 1000) {
    return NextResponse.json({ ok: false, error: 'Too many rows at once.' }, { status: 400 });
  }

  const notice = isoDate(body.noticePlanned);
  const caseReg = isoDate(body.caseRegDate);
  if (notice === undefined || caseReg === undefined) {
    return NextResponse.json({ ok: false, error: 'Invalid date.' }, { status: 400 });
  }

  // `undefined` = not sent, leave ownership alone. `null` = explicitly unassign.
  let assignedTo: string | null | undefined = undefined;
  if ('assignedTo' in body) {
    if (body.assignedTo === null || body.assignedTo === '') assignedTo = null;
    else if (typeof body.assignedTo === 'string') assignedTo = body.assignedTo;
    else {
      return NextResponse.json({ ok: false, error: 'Invalid assignee.' }, { status: 400 });
    }
  }

  if (notice === null && caseReg === null && assignedTo === undefined) {
    return NextResponse.json(
      { ok: false, error: 'Set a date or an assignee.' },
      { status: 400 }
    );
  }

  // Only the fields actually supplied are written: leaving one blank in the bar
  // means "do not touch it", not "clear it".
  const patch: Record<string, string | null> = {};
  if (notice) patch.notice_planned = notice;
  if (caseReg) patch.case_reg_date = caseReg;
  if (assignedTo !== undefined) patch.assigned_to = assignedTo;

  const supabase = getSupabaseAdmin();
  try {
    // The assignee must be someone this company can actually give a file to —
    // an employee or team leader with PayLater access. Handing a file to a
    // lawyer, an auditor, or a stranger's user id would create work nobody can
    // open (see listAssignableMembers).
    if (assignedTo) {
      const allowed = await listAssignableMembers(ctx.companyId);
      if (!allowed.some((m) => m.userId === assignedTo)) {
        return NextResponse.json(
          { ok: false, error: 'That person cannot be assigned PayLater files.' },
          { status: 400 }
        );
      }
    }
    const { data, error } = await supabase
      .from('paylater_customers')
      .update(patch)
      .eq('company_id', ctx.companyId)
      .in('id', ids)
      .select('id');
    if (error) throw error;

    const touched = data ?? [];
    if (touched.length) {
      await supabase.from('paylater_history').insert(
        touched.map((r) => ({
          customer_id: r.id as string,
          event: 'edited',
          actor_id: ctx.pu.userId,
          detail: { bulk: true, ...patch },
        }))
      );
    }

    return NextResponse.json({ ok: true, updated: touched.length });
  } catch (err) {
    console.error('PayLater bulk dates error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
