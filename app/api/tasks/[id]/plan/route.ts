import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { getFileById } from '@/lib/platform/files';
import { getTaskCore, planTask } from '@/lib/platform/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * PATCH /api/tasks/:id/plan — put a task on a day, take it off one, or record
 * how long it is expected to take. The write behind dragging a card on the
 * Employee Tasks calendar.
 *
 * Body (both optional, but at least one required):
 *   { scheduled_date: 'YYYY-MM-DD' | null, estimated_hours: number | null }
 *
 * null is a REAL value on both fields, not "leave it alone": a null
 * scheduled_date drags the task back into the unscheduled pile, and a null
 * estimate withdraws a wrong one. Omitting a field is how you leave it alone.
 *
 * WHY THIS IS ITS OWN ROUTE, NOT PART OF PATCH /api/tasks/:id
 *   The task PATCH is gated behind 'tasks.edit' and, for an employee holding
 *   that as an approval-required grant, parks the edit in the approval queue
 *   until a manager signs it off. That is right for retitling a task or handing
 *   it to someone else. It is wrong for moving a card from Tuesday to
 *   Wednesday: a manager rearranging a week does that twenty times in a sitting,
 *   and routing each one through the queue would bury the requests that matter.
 *   So planning is a separate, narrow write — see planTask() for the full note.
 *
 * WHO MAY DO IT — a MANAGER or ADMIN of the task's company, by role, and nobody
 * else. Deliberately narrower than the task PATCH, which also admits an
 * employee granted 'tasks.edit': that grant was handed out with the approval
 * gate attached, and this route does not run the gate. Honouring the grant here
 * would quietly hand its holder an ungated write the person who granted it
 * never agreed to.
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  let body: { scheduled_date?: unknown; estimated_hours?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  // Distinguish absent (leave alone) from null (clear it) — see the note above.
  const hasDate = Object.prototype.hasOwnProperty.call(body, 'scheduled_date');
  const hasHours = Object.prototype.hasOwnProperty.call(body, 'estimated_hours');
  if (!hasDate && !hasHours) {
    return NextResponse.json(
      { ok: false, error: 'Nothing to update.' },
      { status: 400 }
    );
  }

  let scheduledDate: string | null | undefined;
  if (hasDate) {
    const raw = body.scheduled_date;
    if (raw === null) scheduledDate = null;
    else if (typeof raw === 'string') scheduledDate = raw;
    else {
      return NextResponse.json(
        { ok: false, error: 'scheduled_date must be a date or null.' },
        { status: 400 }
      );
    }
  }

  let estimatedHours: number | null | undefined;
  if (hasHours) {
    const raw = body.estimated_hours;
    if (raw === null) estimatedHours = null;
    else if (typeof raw === 'number') estimatedHours = raw;
    // Accepted as a string too: it arrives from a number input, whose value is
    // always a string, and rejecting "0.5" would be a distinction only the
    // wire format cares about.
    else if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { ok: false, error: 'estimated_hours must be a number or null.' },
          { status: 400 }
        );
      }
      estimatedHours = n;
    } else {
      return NextResponse.json(
        { ok: false, error: 'estimated_hours must be a number or null.' },
        { status: 400 }
      );
    }
  }

  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { ok: false, error: 'Unauthenticated.' },
        { status: 401 }
      );
    }
    const pu = await getPlatformUser(session);
    if (!pu) {
      return NextResponse.json(
        { ok: false, error: 'Unauthenticated.' },
        { status: 401 }
      );
    }

    const task = await getTaskCore(params.id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    // The task's own file decides which company this is — never a company id
    // from the request, which the caller controls.
    const file = await getFileById(task.fileId);
    if (!file) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }

    const role = roleInCompany(pu, file.companyId);
    if (role !== 'admin' && role !== 'manager') {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }

    const result = await planTask({
      taskId: task.id,
      scheduledDate,
      estimatedHours,
    });

    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      if (result.code === 'locked') {
        return NextResponse.json(
          {
            ok: false,
            code: 'locked',
            error: 'This task is completed and can no longer be scheduled.',
          },
          { status: 409 }
        );
      }
      if (result.code === 'unavailable') {
        // The database has not caught up with this build yet (migration #33).
        // 503 rather than 500: nothing is broken, the capability is simply not
        // there for a few more minutes, and a retry is the right response.
        return NextResponse.json(
          {
            ok: false,
            code: 'unavailable',
            error: 'Task scheduling is not available yet. Try again shortly.',
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'Invalid request.' },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Plan task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
