'use client';

import { useState } from 'react';
import type { ClientFile } from '../FilesView';

/**
 * Type-to-confirm delete guard for a folder. Mirrors the employee delete
 * pattern: a destructive (red) modal that lists exactly what will be removed and
 * only enables the Delete button once the confirmation word is re-typed EXACTLY.
 * The server (DELETE /api/files/:id) re-checks authorization and cascades the
 * delete, so this is a safety UX, not the security boundary.
 */
export default function DeleteFolderConfirm({
  file,
  lang,
  onCancel,
  onDeleted,
}: {
  file: ClientFile;
  lang: 'en' | 'ar';
  onCancel: () => void;
  onDeleted: (id: string) => void;
}) {
  const ar = lang === 'ar';
  // The fixed confirmation word that must be re-typed EXACTLY (case-sensitive,
  // no trimming/normalizing) to arm the Delete button. This is a UI guard only —
  // it is NEVER sent to the server; the real authorization is canAdmin there.
  const CONFIRM_WORD = 'alialbaker';
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const canDelete = typed === CONFIRM_WORD;

  async function onConfirm() {
    if (!canDelete || deleting) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(
          data.error || (ar ? 'تعذّر حذف المجلد.' : 'Could not delete the folder.')
        );
        setDeleting(false);
        return;
      }
      onDeleted(file.id);
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setDeleting(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'حذف المجلد' : 'Delete folder'}
      onClick={onCancel}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span
              className="dash-sq"
              style={{ background: '#9a3b2f' }}
              aria-hidden="true"
            />
            {ar ? 'حذف المجلد' : 'Delete folder'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <p className="dash-subtitle" style={{ margin: '4px 0 10px' }}>
          {ar
            ? 'سيُحذف هذا المجلد نهائيًا ولا يمكن التراجع. سيُزال أيضًا:'
            : 'This folder will be permanently deleted and cannot be undone. This also removes:'}
        </p>
        <ul
          className="dash-hint"
          style={{ margin: '0 0 14px', paddingInlineStart: 18 }}
        >
          <li>{ar ? 'جميع مهام المجلد' : 'all of the folder’s tasks'}</li>
          <li>{ar ? 'سجلّ المهام بالكامل' : 'the full task history'}</li>
          <li>
            {ar
              ? 'صلاحيات الوصول وطلبات الوصول'
              : 'file access grants and access requests'}
          </li>
        </ul>

        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="del-folder-confirm">
            {ar ? (
              <>
                اكتب <code>{CONFIRM_WORD}</code> لتأكيد الحذف
              </>
            ) : (
              <>
                Type <code>{CONFIRM_WORD}</code> to confirm deletion
              </>
            )}
          </label>
          <input
            id="del-folder-confirm"
            className="dash-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            dir="ltr"
            placeholder={CONFIRM_WORD}
          />
        </div>

        <div className="dash-modal-actions">
          <button
            type="button"
            className="dash-btn-ghost"
            onClick={onCancel}
            disabled={deleting}
          >
            {ar ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="dash-btn-gold"
            style={{
              background: '#9a3b2f',
              borderColor: '#9a3b2f',
              opacity: canDelete && !deleting ? 1 : 0.5,
            }}
            onClick={onConfirm}
            disabled={!canDelete || deleting}
          >
            {deleting
              ? ar
                ? 'جارٍ الحذف…'
                : 'Deleting…'
              : ar
              ? 'حذف المجلد نهائيًا'
              : 'Delete folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
