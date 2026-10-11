'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import { formatDateTime } from '@/lib/format';
import type { ClientFile } from '../FilesView';
import type { FileCommentDTO } from './types';

/**
 * The folder's comment log and composer — the third tab of the folder drawer.
 *
 * Append-only to everyone except a comment's own author, who may edit their own
 * (the Edit control is rendered for nobody else).
 */
export default function CommentsTab({
  file,
  onCountChange,
}: {
  file: ClientFile;
  /** Reports the comment count up so the tab strip can show it. */
  onCountChange: (n: number) => void;
}) {
  const { t, lang, identity } = useDash();

  const [comments, setComments] = useState<FileCommentDTO[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState(false);
  /** Refused (403/404) rather than failed — see the note in the loader. */
  const [commentsRefused, setCommentsRefused] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [commentErr, setCommentErr] = useState<string | null>(null);

  // Editing an existing comment — only its own author ever sees the control.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState('');
  const [savingEditComment, setSavingEditComment] = useState(false);
  const [editCommentErr, setEditCommentErr] = useState<string | null>(null);

  const loadComments = useCallback(async () => {
    setCommentsLoading(true);
    setCommentsError(false);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/comments`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        comments?: FileCommentDTO[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.comments)) {
        // 403/404 here means "comments on this folder are not yours to read"
        // — a boundary, not breakage. Reading the folder's comment log is
        // gated on holding a permission in the company AND being assigned
        // (see the route). Shouting an error at someone who simply is not
        // included tells them something is broken when nothing is.
        setCommentsRefused(res.status === 403 || res.status === 404);
        setCommentsError(!(res.status === 403 || res.status === 404));
        setComments([]);
      } else {
        setCommentsRefused(false);
        setComments(data.comments);
      }
    } catch {
      setCommentsError(true);
    } finally {
      setCommentsLoading(false);
    }
  }, [file.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  useEffect(() => {
    onCountChange(comments.length);
  }, [comments.length, onCountChange]);

  async function onPostComment(e: React.FormEvent) {
    e.preventDefault();
    const text = newComment.trim();
    if (!text) return;
    setCommentErr(null);
    setPostingComment(true);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        comment?: FileCommentDTO;
      };
      if (!res.ok || !data.ok || !data.comment) {
        setCommentErr(data.error || t.couldNotPostComment);
        setPostingComment(false);
        return;
      }
      setComments((prev) => [...prev, data.comment as FileCommentDTO]);
      setNewComment('');
      setPostingComment(false);
    } catch {
      setCommentErr(t.networkError);
      setPostingComment(false);
    }
  }

  function startEditComment(c: FileCommentDTO) {
    setEditingCommentId(c.id);
    setEditingCommentBody(c.body);
    setEditCommentErr(null);
  }

  function cancelEditComment() {
    setEditingCommentId(null);
    setEditingCommentBody('');
    setEditCommentErr(null);
  }

  async function onSaveEditComment(e: React.FormEvent) {
    e.preventDefault();
    const text = editingCommentBody.trim();
    if (!text || !editingCommentId) return;
    setEditCommentErr(null);
    setSavingEditComment(true);
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(file.id)}/comments/${encodeURIComponent(editingCommentId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: text }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        comment?: FileCommentDTO;
      };
      if (!res.ok || !data.ok || !data.comment) {
        setEditCommentErr(data.error || t.couldNotPostComment);
        setSavingEditComment(false);
        return;
      }
      const updated = data.comment;
      setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setSavingEditComment(false);
      cancelEditComment();
    } catch {
      setEditCommentErr(t.networkError);
      setSavingEditComment(false);
    }
  }

  return (
    <div className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
      {commentsLoading ? (
        <p className="dash-hint" style={{ margin: 0 }}>
          …
        </p>
      ) : commentsRefused ? (
        <p className="dash-hint" style={{ margin: 0 }}>
          {lang === 'ar'
            ? 'تعليقات هذا المجلد غير متاحة لك.'
            : 'The comments on this folder are not available to you.'}
        </p>
      ) : commentsError ? (
        <div className="dash-alert dash-alert-error" role="alert">
          {t.couldNotLoadComments}
        </div>
      ) : comments.length === 0 ? (
        <p className="dash-hint" style={{ margin: '0 0 10px' }}>
          {t.noComments}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 10px', padding: 0 }}>
          {comments.map((c) => (
            <li
              key={c.id}
              style={{
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {(lang === 'ar' ? c.authorNameAr : c.authorNameEn) ||
                    c.authorNameEn ||
                    c.authorNameAr ||
                    c.authorEmail ||
                    '—'}
                </span>
                <span
                  className="dash-hint"
                  style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}
                  dir="auto"
                >
                  {formatDateTime(c.createdAt, lang)}
                  {c.editedAt && <span>({lang === 'ar' ? 'مُعدَّل' : 'edited'})</span>}
                  {identity.userId === c.authorId && editingCommentId !== c.id && (
                    <button
                      type="button"
                      onClick={() => startEditComment(c)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--albaker-gold)',
                        cursor: 'pointer',
                        fontSize: 12.5,
                        padding: 0,
                      }}
                    >
                      {lang === 'ar' ? 'تعديل' : 'Edit'}
                    </button>
                  )}
                </span>
              </div>
              {editingCommentId === c.id ? (
                <form onSubmit={onSaveEditComment}>
                  {editCommentErr && (
                    <div className="dash-alert dash-alert-error" role="alert">
                      {editCommentErr}
                    </div>
                  )}
                  <textarea
                    id={`edit-comment-${c.id}`}
                    className="dash-input"
                    value={editingCommentBody}
                    onChange={(e) => setEditingCommentBody(e.target.value)}
                    rows={2}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="dash-btn-ghost"
                      onClick={cancelEditComment}
                      disabled={savingEditComment}
                    >
                      {t.cancel}
                    </button>
                    <button
                      type="submit"
                      className="dash-btn-gold"
                      disabled={
                        savingEditComment || editingCommentBody.trim().length === 0
                      }
                    >
                      {savingEditComment ? t.posting : t.postComment}
                    </button>
                  </div>
                </form>
              ) : (
                <p
                  dir="auto"
                  style={{ margin: 0, fontSize: 13.5, whiteSpace: 'pre-wrap' }}
                >
                  {c.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {commentErr && (
        <div className="dash-alert dash-alert-error" role="alert">
          {commentErr}
        </div>
      )}

      <form onSubmit={onPostComment}>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="fd-new-comment">
            {t.addComment}
          </label>
          <textarea
            id="fd-new-comment"
            className="dash-input"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            rows={2}
            placeholder={t.commentPlaceholder}
          />
        </div>
        <button
          type="submit"
          className="dash-btn-gold"
          disabled={postingComment || newComment.trim().length === 0}
        >
          {postingComment ? t.posting : t.postComment}
        </button>
      </form>
    </div>
  );
}
