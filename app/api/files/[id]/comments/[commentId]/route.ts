import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { getFileById, type PlatformFile } from '@/lib/platform/files';
import {
  getCommentBrief,
  updateComment,
  notifyMentionedUsers,
} from '@/lib/platform/comments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string; commentId: string } };

/**
 * PATCH /api/files/:id/comments/:commentId — edit a comment's body.
 *
 * ONLY the comment's own author may edit it — no admin/manager override.
 * Body: { body }. Re-derives @mentions from the new text and notifies them
 * (same as posting), so re-editing a mention back in re-notifies — harmless.
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
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
  const mentionedUserIds = Array.isArray(body.mentioned_user_ids)
    ? body.mentioned_user_ids.filter((x): x is string => typeof x === 'string')
    : [];

  let existing;
  try {
    existing = await getCommentBrief(params.commentId);
  } catch (err) {
    console.error('Edit comment (lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!existing || existing.fileId !== params.id) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
  // Author-only — not even an admin/manager override.
  if (existing.authorId !== pu.userId) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(params.id);
  } catch (err) {
    console.error('Edit comment (file lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  try {
    const comment = await updateComment(params.commentId, text);
    if (!comment) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
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
    return NextResponse.json({ ok: true, comment });
  } catch (err) {
    console.error('Edit comment error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
