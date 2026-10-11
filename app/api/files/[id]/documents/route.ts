import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { getFileById, isFileAssignedToUser } from '@/lib/platform/files';
import { parseDriveFolderId, listFolderDocuments } from '@/lib/platform/drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * GET /api/files/:id/documents — the documents in the folder's linked Drive
 * folder.
 *
 * AUTHORISATION IS OURS, NOT GOOGLE'S. The service account can read every
 * folder shared with it, so this route must apply the same rule that already
 * governs the Drive LINK: admin, a manager of the folder's company, or an
 * employee actually assigned to the folder. Anyone else gets 404, as elsewhere
 * across the isolation boundary.
 *
 * `state` distinguishes the ways this can legitimately come back empty, because
 * they need different words in the UI and different fixes by a human:
 *   ok                → documents listed
 *   no_link           → nothing in the Drive field
 *   not_a_drive_link  → the field holds text that is not a Drive folder URL
 *   unconfigured      → this deployment has no service-account credentials
 *   bad_credentials   → credentials exist but Google rejected them
 *   no_access         → the folder is not shared with the service account
 *   drive_error       → Google refused or failed for another reason
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  try {
    const file = await getFileById(params.id);
    if (!file) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    const role = roleInCompany(pu, file.companyId);
    const isManagerOrAdmin = role === 'admin' || role === 'manager';
    if (!isManagerOrAdmin && !(await isFileAssignedToUser(file.id, pu.userId))) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }

    const parsed = parseDriveFolderId(file.driveLink);
    if (parsed.kind === 'none') {
      return NextResponse.json({ ok: true, state: 'no_link', documents: [] });
    }
    if (parsed.kind === 'not_a_drive_link') {
      return NextResponse.json({
        ok: true,
        state: 'not_a_drive_link',
        storedValue: parsed.raw,
        documents: [],
      });
    }

    const result = await listFolderDocuments(parsed.folderId);
    if (!result.ok) {
      return NextResponse.json({
        ok: true,
        state: result.code,
        // Describes the shape of a credential problem so it can be fixed
        // without reading server logs. Never contains the key.
        detail: result.detail,
        documents: [],
      });
    }
    return NextResponse.json({
      ok: true,
      state: 'ok',
      folderLink: file.driveLink,
      documents: result.documents,
    });
  } catch (err) {
    console.error('File documents error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
