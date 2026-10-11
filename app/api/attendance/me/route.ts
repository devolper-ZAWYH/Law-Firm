import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { myAttendanceSummary } from '@/lib/platform/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/attendance/me — the CALLER's own lateness: yesterday +
 * running total for the current period (25th→24th). Any authenticated user
 * — it only ever describes their own data, never anyone else's.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  try {
    const summary = await myAttendanceSummary(pu.userId);
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    console.error('My attendance summary error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
