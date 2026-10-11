import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { getTaskCore, markTaskDone } from '@/lib/platform/tasks';
import { notifyTaskDone } from '@/lib/platform/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/tasks/:id/done — the ASSIGNEE marks the task done.
 *
 * ONLY the named assignee (caller.id === task.assignee_id) may do this; anyone
 * else → 403. The task must be 'open'. Freezes the working-time timer and moves
 * it to 'awaiting_approval' (see markTaskDone). Writes a 'marked_done' event
 * carrying the OPTIONAL body { note } — the employee's comment describing what
 * they did, which the approver reads before approving or sending back.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
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

  // OPTIONAL body: { note } — the employee's comment on what they did. A missing
  // or unparseable body is fine (older clients POST with no body at all).
  let doneNote = '';
  try {
    const body = (await req.json()) as { note?: unknown };
    if (typeof body?.note === 'string') doneNote = body.note.trim();
  } catch {
    doneNote = '';
  }

  try {
    const task = await getTaskCore(params.id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    // Only the assignee may mark their own task done.
    if (task.assigneeId !== pu.userId) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }

    const result = await markTaskDone(params.id, pu.userId, doneNote);
    if (!result.ok) {
      if (result.code === 'forbidden') {
        return NextResponse.json(
          { ok: false, error: 'Forbidden.' },
          { status: 403 }
        );
      }
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      // bad_state — already awaiting/approved.
      return NextResponse.json(
        { ok: false, error: 'This task can no longer be marked done.' },
        { status: 409 }
      );
    }
    // Phase 7: notify the named approver that the task awaits approval. Gated by
    // the company's alerts_enabled inside notifyTaskDone; best-effort — a failed
    // notification must not break the action.
    try {
      await notifyTaskDone(params.id);
    } catch (notifyErr) {
      console.error('notifyTaskDone failed:', notifyErr);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Mark task done error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
