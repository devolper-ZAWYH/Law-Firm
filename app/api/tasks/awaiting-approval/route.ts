import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { listAwaitingApprovalForApprover } from '@/lib/platform/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/awaiting-approval — the caller's "Awaiting my approval" queue:
 * every task where approver_id === caller AND status === 'awaiting_approval',
 * across ALL of the caller's companies. Enriched with file briefs + history.
 *
 * Scoped by approver identity, so any authenticated user may call it — it only
 * ever returns tasks on which THEY are the named approver.
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
    const tasks = await listAwaitingApprovalForApprover(pu.userId);
    return NextResponse.json({ ok: true, tasks });
  } catch (err) {
    console.error('Awaiting-approval list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
