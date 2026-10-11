import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { evaluateAlerts } from '@/lib/platform/alerts';
import { rateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/companies/:id/alerts/evaluate — manually trigger the alert engine
 * for one company. Any ADMIN or MANAGER/employee member of the company may
 * trigger it (the engine itself is a no-op when the company has alerts disabled
 * or the migration isn't applied). Non-members → 403.
 *
 * evaluateAlerts is best-effort internally; we still wrap it so the route never
 * 500s on a transient failure.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
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
  const companyId = params.id;
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // Each run scans every file and every open task in the company, and any
  // member can call this. Without a ceiling a single employee could hold the
  // database busy with full scans indefinitely. Six per minute is far above
  // what the UI generates (it triggers on page load, not in a loop).
  const rl = rateLimit(`alerts:evaluate:${pu.userId}:${companyId}`, 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
    );
  }

  try {
    await evaluateAlerts(companyId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Manual evaluateAlerts error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
