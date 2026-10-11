import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { getTaskCore, approveTask } from '@/lib/platform/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/tasks/:id/approve — approve a task awaiting approval.
 *
 * ONLY the named approver (caller.id === task.approver_id) OR a global admin may
 * approve. Any other manager of the company → 403 (approval authority is the
 * SPECIFIC named approver, not "any manager"). Self-approval is legal. Moves the
 * task to 'approved'; the timer was already frozen at the done step.
 */
export async function POST(_req: NextRequest, { params }: RouteContext) {
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

  try {
    const task = await getTaskCore(params.id);
    if (!task) {
      return NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      );
    }
    // The named approver, or a global admin (master key).
    if (task.approverId !== pu.userId && !pu.isAdmin) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }

    const result = await approveTask(params.id, pu.userId);
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      // bad_state — not awaiting approval anymore.
      return NextResponse.json(
        { ok: false, error: 'This task is not awaiting approval.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Approve task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
