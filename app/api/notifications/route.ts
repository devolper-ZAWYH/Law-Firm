import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { listNotificationsForUser } from '@/lib/platform/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/notifications — the CALLER'S OWN notifications, newest-first, with an
 * unread count. A caller can only ever see their own rows (user_id == self).
 * Degrades to an empty list if the Phase-7 migration hasn't been applied.
 */
export async function GET(_req: NextRequest) {
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
    const { notifications, unreadCount } = await listNotificationsForUser(
      pu.userId
    );
    return NextResponse.json({ ok: true, notifications, unreadCount });
  } catch (err) {
    console.error('List notifications error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
