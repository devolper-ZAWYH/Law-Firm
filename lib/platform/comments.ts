import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { insertNotifications } from './notifications';

/**
 * File comments — a timestamped log on each folder (file_comments table,
 * migrations #18-19). The author (and only the author) may edit their own
 * comment's body; edited_at is stamped so the UI can show "(edited)" — no
 * edit history is kept, the previous body is simply overwritten. No delete.
 */

export interface FileComment {
  id: string;
  fileId: string;
  authorId: string;
  authorNameEn: string | null;
  authorNameAr: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

interface CommentRow {
  id: string;
  file_id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

interface AuthorRow {
  id: string;
  full_name_en: string | null;
  full_name_ar: string | null;
  email: string | null;
  username: string;
}

/** Every comment on one folder, oldest first. */
export async function listComments(fileId: string): Promise<FileComment[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_comments')
    .select('id, file_id, author_id, body, created_at, edited_at')
    .eq('file_id', fileId)
    .order('created_at', { ascending: true });
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data as CommentRow[] | null) ?? [];
  if (rows.length === 0) return [];

  const authorIds = Array.from(new Set(rows.map((r) => r.author_id)));
  const authorsRes = await supabase
    .from('app_users')
    .select('id, full_name_en, full_name_ar, email, username')
    .in('id', authorIds);
  if (authorsRes.error) throw new Error(authorsRes.error.message);
  const authorById = new Map<string, AuthorRow>(
    ((authorsRes.data as AuthorRow[] | null) ?? []).map((a) => [a.id, a])
  );

  return rows.map((r) => {
    const author = authorById.get(r.author_id);
    return {
      id: r.id,
      fileId: r.file_id,
      authorId: r.author_id,
      authorNameEn: author?.full_name_en ?? null,
      authorNameAr: author?.full_name_ar ?? null,
      authorEmail: author?.email ?? author?.username ?? null,
      body: r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
    };
  });
}

/** Post a new comment. Authorization (viewer of the folder) enforced by the caller. */
export async function createComment(input: {
  fileId: string;
  authorId: string;
  body: string;
}): Promise<FileComment> {
  const supabase = getSupabaseAdmin();
  const insRes = await supabase
    .from('file_comments')
    .insert({ file_id: input.fileId, author_id: input.authorId, body: input.body })
    .select('id, file_id, author_id, body, created_at, edited_at')
    .single();
  if (insRes.error) throw new Error(insRes.error.message);
  const row = insRes.data as CommentRow;

  const authorRes = await supabase
    .from('app_users')
    .select('id, full_name_en, full_name_ar, email, username')
    .eq('id', row.author_id)
    .maybeSingle();
  if (authorRes.error) throw new Error(authorRes.error.message);
  const author = authorRes.data as AuthorRow | null;

  return {
    id: row.id,
    fileId: row.file_id,
    authorId: row.author_id,
    authorNameEn: author?.full_name_en ?? null,
    authorNameAr: author?.full_name_ar ?? null,
    authorEmail: author?.email ?? author?.username ?? null,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

/**
 * Get one comment's author id (for the caller to check "is this my
 * comment?" before allowing an edit) plus its folder id (for isolation).
 */
export async function getCommentBrief(
  commentId: string
): Promise<{ id: string; fileId: string; authorId: string } | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_comments')
    .select('id, file_id, author_id')
    .eq('id', commentId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { id: string; file_id: string; author_id: string } | null;
  return row ? { id: row.id, fileId: row.file_id, authorId: row.author_id } : null;
}

/**
 * Edit a comment's body. Authorization (only the comment's own author may
 * edit — enforced by the caller) happens before this is called. Stamps
 * edited_at so the UI can show "(edited)"; no history of the previous body
 * is kept.
 */
export async function updateComment(
  commentId: string,
  body: string
): Promise<FileComment | null> {
  const supabase = getSupabaseAdmin();
  const updRes = await supabase
    .from('file_comments')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', commentId)
    .select('id, file_id, author_id, body, created_at, edited_at')
    .maybeSingle();
  if (updRes.error) throw new Error(updRes.error.message);
  const row = updRes.data as CommentRow | null;
  if (!row) return null;

  const authorRes = await supabase
    .from('app_users')
    .select('id, full_name_en, full_name_ar, email, username')
    .eq('id', row.author_id)
    .maybeSingle();
  if (authorRes.error) throw new Error(authorRes.error.message);
  const author = authorRes.data as AuthorRow | null;

  return {
    id: row.id,
    fileId: row.file_id,
    authorId: row.author_id,
    authorNameEn: author?.full_name_en ?? null,
    authorNameAr: author?.full_name_ar ?? null,
    authorEmail: author?.email ?? author?.username ?? null,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

/**
 * Notify every @mentioned user of a new comment — best-effort, never throws.
 * Only actually members of the folder's company are notified (a mention
 * pointing outside the company is silently dropped, defense in depth on top
 * of the client only ever offering company members to mention); the author
 * mentioning themselves is skipped.
 */
export async function notifyMentionedUsers(input: {
  mentionedUserIds: string[];
  companyId: string;
  authorId: string;
  authorNameEn: string | null;
  authorNameAr: string | null;
  fileId: string;
  fileClientNameEn: string;
  fileClientNameAr: string;
  commentBody: string;
}): Promise<void> {
  const candidateIds = Array.from(
    new Set(input.mentionedUserIds.filter((id) => id && id !== input.authorId))
  );
  if (candidateIds.length === 0) return;

  const supabase = getSupabaseAdmin();
  const memRes = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', input.companyId)
    .in('user_id', candidateIds);
  if (memRes.error) {
    console.error('Notify mentions (membership check) error:', memRes.error.message);
    return;
  }
  const validIds = ((memRes.data as { user_id: string }[] | null) ?? []).map(
    (r) => r.user_id
  );
  if (validIds.length === 0) return;

  const authorName = input.authorNameAr || input.authorNameEn || 'Someone';
  const snippet =
    input.commentBody.length > 140
      ? `${input.commentBody.slice(0, 140)}…`
      : input.commentBody;

  await insertNotifications(
    validIds.map((userId) => ({
      userId,
      companyId: input.companyId,
      taskId: null,
      type: 'mention' as const,
      level: null,
      messageEn: `${authorName} mentioned you on "${input.fileClientNameEn}": ${snippet}`,
      messageAr: `أشار إليك ${authorName} في "${input.fileClientNameAr}": ${snippet}`,
    }))
  );
}
