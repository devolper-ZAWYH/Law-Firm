import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { listOpenForApprover } from '@/lib/platform/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/pending-approval — tasks where the caller is the named
 * approver but the assignee hasn't marked them done yet (status == 'open'),
 * across ALL of the caller's companies. Powers "My Tasks"'s "Tasks you'll
 * approve" section — lets an approver see a task exists right away instead
 * of only once it reaches 'awaiting_approval'.
 *
 * Scoped by approver identity, so any authenticated user may call it — it
 * only ever returns tasks on which THEY are the named approver.
 */
export async function GET() {
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
    const tasks = await listOpenForApprover(pu.userId);
    return NextResponse.json({ ok: true, tasks });
  } catch (err) {
    console.error('Pending-approval list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
