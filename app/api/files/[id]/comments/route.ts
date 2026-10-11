import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import {
  getPlatformUser,
  roleInCompany,
  hasFilePermissionInCompany,
} from '@/lib/platform/auth';
import {
  getFileById,
  isFileAssignedToUser,
  type PlatformFile,
} from '@/lib/platform/files';
import {
  listComments,
  createComment,
  notifyMentionedUsers,
} from '@/lib/platform/comments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * GET /api/files/:id/comments — the folder's comment log, oldest first.
 * POST /api/files/:id/comments — add a comment. Body: { body }.
 *
 * Same audience as the folder itself: a global admin, a manager of the
 * folder's company, or an employee with any granted permission there
 * (lib/platform/permissions.ts) — matching the Folders page access rule in
 * app/admin/files/page.tsx. 404 across the isolation boundary.
 */

async function canView(
  pu: NonNullable<Awaited<ReturnType<typeof getPlatformUser>>>,
  file: PlatformFile
): Promise<boolean> {
  const role = roleInCompany(pu, file.companyId);
  if (role === 'admin' || role === 'manager') return true;
  // An employee additionally needs the folder to be THEIRS. A permission grant
  // says what they may DO with a folder, never which folders they can reach.
  if (!hasFilePermissionInCompany(pu, file.companyId)) return false;
  return isFileAssignedToUser(file.id, pu.userId);
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(params.id);
  } catch (err) {
    console.error('List comments (file lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
  if (!(await canView(pu, file))) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  try {
    const comments = await listComments(file.id);
    return NextResponse.json({ ok: true, comments });
  } catch (err) {
    console.error('List comments error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  let body: { body?: unknown; mentioned_user_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const mentionedUserIds = Array.isArray(body.mentioned_user_ids)
    ? body.mentioned_user_ids.filter((x): x is string => typeof x === 'string')
    : [];
  if (!text) {
    return NextResponse.json(
      { ok: false, error: 'Comment cannot be empty.' },
      { status: 400 }
    );
  }
  if (text.length > 4000) {
    return NextResponse.json(
      { ok: false, error: 'Comment is too long.' },
      { status: 400 }
    );
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(params.id);
  } catch (err) {
    console.error('Add comment (file lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
  if (!(await canView(pu, file))) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  try {
    const gate = await gateAction({
      userId: pu.userId,
      companyId: file.companyId,
      capabilityKey: 'files.comments.add',
      payload: { fileId: file.id, body: text },
      summaryEn: `Post a comment on the folder for ${file.clientEn || file.clientAr}`,
      summaryAr: `إضافة تعليق على مجلد ${file.clientAr || file.clientEn}`,
      isPrivileged: (() => {
        const r = roleInCompany(pu, file.companyId);
        return r === 'admin' || r === 'manager';
      })(),
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const comment = await createComment({
      fileId: file.id,
      authorId: pu.userId,
      body: text,
    });
    if (mentionedUserIds.length > 0) {
      await notifyMentionedUsers({
        mentionedUserIds,
        companyId: file.companyId,
        authorId: pu.userId,
        authorNameEn: pu.fullNameEn,
        authorNameAr: pu.fullNameAr,
        fileId: file.id,
        fileClientNameEn: file.clientEn,
        fileClientNameAr: file.clientAr,
        commentBody: text,
      });
    }
    return NextResponse.json({ ok: true, comment }, { status: 201 });
  } catch (err) {
    console.error('Add comment error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
