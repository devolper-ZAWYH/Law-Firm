'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import { formatDateTime } from '@/lib/format';
import type { ClientFile } from '../FilesView';

/**
 * The folder's ONE standing summary — what this matter is, as it stands now.
 *
 * Not a thread: there is a single body, written once and edited afterwards.
 * Anyone who can see the folder can read it; writing needs a manager/admin or
 * the 'files.summary' grant, which the server decides and reports as canWrite.
 */

interface SummaryDTO {
  body: string;
  createdByName: string | null;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

export default function SummaryTab({
  file,
  onHasSummaryChange,
}: {
  file: ClientFile;
  /** Reports whether a summary exists, so the tab strip can mark it. */
  onHasSummaryChange: (has: boolean) => void;
}) {
  const { t, lang } = useDash();
  const ar = lang === 'ar';

  const [summary, setSummary] = useState<SummaryDTO | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(file.id)}/summary?lang=${lang}`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        summary?: SummaryDTO | null;
        canWrite?: boolean;
      };
      if (!res.ok || !data.ok) {
        setLoadError(true);
        setSummary(null);
      } else {
        setSummary(data.summary ?? null);
        setCanWrite(data.canWrite === true);
        onHasSummaryChange(!!data.summary);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [file.id, lang, onHasSummaryChange]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/summary`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, lang }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        summary?: SummaryDTO;
      };
      if (!res.ok || !data.ok || !data.summary) {
        setErr(data.error || t.networkError);
        setSaving(false);
        return;
      }
      setSummary(data.summary);
      onHasSummaryChange(true);
      setEditing(false);
      setSaving(false);
    } catch {
      setErr(t.networkError);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <p className="dash-hint" style={{ margin: 0 }}>
        …
      </p>
    );
  }

  if (loadError) {
    return (
      <div className="dash-alert dash-alert-error" role="alert">
        {ar ? 'تعذّر تحميل الملخص.' : 'Could not load the summary.'}
      </div>
    );
  }

  if (editing) {
    return (
      <form onSubmit={onSave} className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
        {err && (
          <div className="dash-alert dash-alert-error" role="alert">
            {err}
          </div>
        )}
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="fd-summary">
            {ar ? 'ملخص الملف' : 'File summary'}
          </label>
          <textarea
            id="fd-summary"
            className="dash-input"
            dir="auto"
            rows={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              ar ? 'اكتب ملخصًا لهذا الملف…' : 'Describe this matter…'
            }
          />
        </div>
        <div className="dash-modal-actions">
          <button
            type="button"
            className="dash-btn-ghost"
            onClick={() => {
              setEditing(false);
              setErr(null);
            }}
            disabled={saving}
          >
            {t.cancel}
          </button>
          <button
            type="submit"
            className="dash-btn-gold"
            disabled={saving || draft.trim().length === 0}
          >
            {saving ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'حفظ' : 'Save'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
      {summary ? (
        <>
          <p
            dir="auto"
            style={{ margin: '0 0 10px', fontSize: 14, whiteSpace: 'pre-wrap' }}
          >
            {summary.body}
          </p>
          <p className="dash-hint" style={{ margin: 0 }} dir="auto">
            {ar ? 'آخر تحديث' : 'Last updated'}{' '}
            {formatDateTime(summary.updatedAt, lang)}
            {summary.updatedByName ? ` · ${summary.updatedByName}` : ''}
          </p>
          {canWrite && (
            <button
              type="button"
              className="dash-btn-ghost"
              style={{ marginTop: 12 }}
              onClick={() => {
                setDraft(summary.body);
                setEditing(true);
              }}
            >
              {ar ? 'تعديل الملخص' : 'Edit summary'}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="dash-hint" style={{ margin: '0 0 10px' }}>
            {ar ? 'لا يوجد ملخص لهذا الملف بعد.' : 'No summary for this folder yet.'}
          </p>
          {canWrite && (
            <button
              type="button"
              className="dash-btn-gold"
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              {ar ? 'إضافة ملخص' : 'Add summary'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
