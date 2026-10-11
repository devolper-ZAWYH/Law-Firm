'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import { formatDate } from '@/lib/format';
import GoogleDriveIcon from '../GoogleDriveIcon';
import type { ClientFile } from '../FilesView';

/**
 * The documents inside the folder's linked Drive folder. Clicking one opens it
 * in Drive, in a new tab.
 *
 * The empty cases are deliberately NOT one message. "Nothing is linked" and
 * "what is linked is not a Drive link" are different problems with different
 * fixes, and in this database the second is common — the Drive field has been
 * used as a free-text note on more than a third of folders.
 */

interface DriveDoc {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime: string | null;
  isFolder: boolean;
}

type State =
  | 'ok'
  | 'no_link'
  | 'not_a_drive_link'
  | 'unconfigured'
  | 'bad_credentials'
  | 'no_access'
  | 'drive_error';

/** A short, human label for the common Google types; the rest fall back. */
function kindLabel(mimeType: string, isFolder: boolean, ar: boolean): string {
  if (isFolder) return ar ? 'مجلد' : 'Folder';
  if (mimeType.includes('spreadsheet')) return ar ? 'جدول' : 'Sheet';
  if (mimeType.includes('presentation')) return ar ? 'عرض' : 'Slides';
  if (mimeType.includes('document')) return ar ? 'مستند' : 'Doc';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return ar ? 'صورة' : 'Image';
  return ar ? 'ملف' : 'File';
}

export default function DocumentsTab({
  file,
  onCountChange,
}: {
  file: ClientFile;
  onCountChange: (n: number | null) => void;
}) {
  const { t, lang } = useDash();
  const ar = lang === 'ar';

  const [docs, setDocs] = useState<DriveDoc[]>([]);
  const [state, setState] = useState<State>('ok');
  const [storedValue, setStoredValue] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [folderLink, setFolderLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(file.id)}/documents`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        state?: State;
        documents?: DriveDoc[];
        storedValue?: string;
        folderLink?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        setLoadError(true);
        onCountChange(null);
        return;
      }
      const list = Array.isArray(data.documents) ? data.documents : [];
      setDocs(list);
      setState(data.state ?? 'ok');
      setStoredValue(data.storedValue ?? null);
      setDetail(data.detail ?? null);
      setFolderLink(data.folderLink ?? null);
      onCountChange(data.state === 'ok' ? list.length : null);
    } catch {
      setLoadError(true);
      onCountChange(null);
    } finally {
      setLoading(false);
    }
  }, [file.id, onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

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
        {ar ? 'تعذّر تحميل المستندات.' : 'Could not load the documents.'}
      </div>
    );
  }

  if (state !== 'ok') {
    const messages: Record<Exclude<State, 'ok'>, { title: string; hint?: string }> = {
      no_link: {
        title: ar
          ? 'لا يوجد مجلد درايف مرتبط بهذا الملف.'
          : 'No Drive folder linked to this file.',
      },
      not_a_drive_link: {
        title: ar
          ? 'لا يوجد مجلد درايف مرتبط بهذا الملف.'
          : 'No Drive folder linked to this file.',
        // Said quietly, but said: whoever maintains the folder needs to know the
        // field holds a note rather than a link.
        hint: ar
          ? `القيمة المحفوظة ليست رابط مجلد درايف: «${storedValue ?? ''}»`
          : `The stored value is not a Drive folder link: “${storedValue ?? ''}”`,
      },
      bad_credentials: {
        title: ar
          ? 'بيانات اعتماد جوجل درايف غير صحيحة.'
          : 'The Google Drive credentials were rejected.',
        hint: detail ?? undefined,
      },
      unconfigured: {
        title: ar
          ? 'لم يتم إعداد الاتصال بجوجل درايف بعد.'
          : 'The Google Drive connection is not set up yet.',
        hint: ar
          ? 'يمكن فتح المجلد من أيقونة درايف بالأعلى.'
          : 'The folder can still be opened from the Drive icon above.',
      },
      no_access: {
        title: ar
          ? 'المجلد غير مشارَك مع حساب النظام.'
          : 'This folder is not shared with the portal’s service account.',
        hint: ar
          ? 'شارك المجلد مع بريد حساب الخدمة ليظهر محتواه هنا.'
          : 'Share the folder with the service account’s email to list it here.',
      },
      drive_error: {
        title: ar
          ? 'تعذّر الوصول إلى جوجل درايف.'
          : 'Google Drive could not be reached.',
      },
    };
    const m = messages[state];
    return (
      <div className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
        <p className="dash-hint" style={{ margin: 0 }}>
          {m.title}
        </p>
        {m.hint && (
          <p className="dash-hint" style={{ margin: '6px 0 0' }} dir="auto">
            {m.hint}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
      {folderLink && (
        <a
          className="dash-btn-ghost fd-doc-openfolder"
          href={folderLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          <GoogleDriveIcon size={16} />
          {ar ? 'فتح المجلد في درايف' : 'Open the folder in Drive'}
        </a>
      )}

      {docs.length === 0 ? (
        <p className="dash-hint" style={{ margin: '10px 0 0' }}>
          {ar ? 'المجلد فارغ.' : 'This Drive folder is empty.'}
        </p>
      ) : (
        <ul className="fd-doc-list">
          {docs.map((d) => (
            <li key={d.id}>
              <a
                className="fd-doc"
                href={d.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                title={d.name}
              >
                <span className="fd-doc-kind">
                  {kindLabel(d.mimeType, d.isFolder, ar)}
                </span>
                <span className="fd-doc-name" dir="auto">
                  {d.name}
                </span>
                {d.modifiedTime && (
                  <span className="fd-doc-date" dir="auto">
                    {formatDate(d.modifiedTime, lang)}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
