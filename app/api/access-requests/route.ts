import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin } from '@/lib/platform/auth';
import { listAllPendingRequests } from '@/lib/platform/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/access-requests?status=pending — the Admin review queue.
 *
 * ADMIN ONLY (global is_admin): an admin oversees ALL companies, so this lists
 * requests across every company, enriched with file + employee + requesting
 * manager info for the UI. `status` defaults to 'pending'. Non-admin → 403.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  const raw = req.nextUrl.searchParams.get('status');
  const status =
    raw === 'approved' || raw === 'rejected' ? raw : 'pending';

  try {
    const requests = await listAllPendingRequests(status);
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    console.error('List access requests error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
