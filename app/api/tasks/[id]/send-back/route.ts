import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { getTaskCore, sendBackTask } from '@/lib/platform/tasks';
import { notifyTaskSentBack } from '@/lib/platform/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/tasks/:id/send-back — bounce a task back to the assignee.
 *
 * ONLY the named approver (caller.id === task.approver_id) OR a global admin may
 * send back. Body: { note } (REQUIRED — the reason, shown on the task). Moves
 * the task to 'open' and RESUMES the timer (accumulated kept, not reset). Writes
 * a 'sent_back' event carrying the note.
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

  let body: { note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) {
    return NextResponse.json(
      { ok: false, error: 'A note is required to send a task back.' },
      { status: 400 }
    );
  }

  try {
    const task = await getTaskCore(params.id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    if (task.approverId !== pu.userId && !pu.isAdmin) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }

    const result = await sendBackTask(params.id, pu.userId, note);
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      if (result.code === 'bad_input') {
        return NextResponse.json(
          { ok: false, error: 'A note is required to send a task back.' },
          { status: 400 }
        );
      }
      // bad_state — not awaiting approval anymore.
      return NextResponse.json(
        { ok: false, error: 'This task is not awaiting approval.' },
        { status: 409 }
      );
    }
    // Phase 7: notify the responsible employee their task was sent back. Gated by
    // the company's alerts_enabled inside notifyTaskSentBack; best-effort.
    try {
      await notifyTaskSentBack(params.id);
    } catch (notifyErr) {
      console.error('notifyTaskSentBack failed:', notifyErr);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Send task back error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
