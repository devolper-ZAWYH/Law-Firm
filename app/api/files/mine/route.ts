import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { listFilesForEmployee } from '@/lib/platform/files';
import { wholesaleVisibleSections } from '@/lib/platform/fileVisibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/mine?company_id=<uuid> — the caller's OWN folders in ONE
 * company: files where they have an ACTIVE access grant OR an assigned task.
 * Powers the employee "My Files" view (Potential + Active sections).
 *
 * Company isolation is a hard boundary, enforced here AND in the data layer:
 *   • the caller must hold a role in the requested company (else 403);
 *   • listFilesForEmployee additionally scopes every row to company_id.
 * Any member role (employee / manager / admin) may call — it only ever returns
 * THEIR OWN files, and Drive links are access-gated server-side, so nothing
 * about another employee's or another company's files can leak.
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
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  const companyId = req.nextUrl.searchParams.get('company_id') ?? '';
  if (!companyId) {
    return NextResponse.json(
      { ok: false, error: 'company_id is required.' },
      { status: 400 }
    );
  }

  // The company must be inside the caller's isolation boundary.
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  try {
    // Honours the same per-section wholesale grants as /api/files, so the two
    // lists cannot disagree about which folders exist for this person.
    const sections = await wholesaleVisibleSections(pu.userId, companyId);
    const files = await listFilesForEmployee(companyId, pu.userId, sections);
    return NextResponse.json({ ok: true, files });
  } catch (err) {
    console.error('My files list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
