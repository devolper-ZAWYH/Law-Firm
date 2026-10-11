import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin } from '@/lib/platform/auth';
import { approveAccessRequest } from '@/lib/platform/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/access-requests/:id/approve — ADMIN ONLY.
 *
 * Approving is what actually grants access: it creates the file_access row for
 * (file, employee) and marks the request approved (decided_by/at). Non-admin →
 * 403. Not pending → 409.
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
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  try {
    const result = await approveAccessRequest(params.id, pu.userId);
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      // not_pending — someone already decided it.
      return NextResponse.json(
        { ok: false, error: 'This request has already been decided.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Approve access request error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
