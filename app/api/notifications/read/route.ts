import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { markNotificationsRead } from '@/lib/platform/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/notifications/read — mark the caller's notifications read.
 * Body: { id?: string }. With an id → just that notification (scoped to the
 * caller, so you can only mark your own). Without → ALL of the caller's unread.
 */
export async function POST(req: NextRequest) {
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

  let body: { id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Empty/invalid body → mark all read.
    body = {};
  }
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;

  try {
    await markNotificationsRead(pu.userId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Mark notifications read error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
