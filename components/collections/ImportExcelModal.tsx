'use client';

/**
 * v2's Excel import: choose the file and the target batch, REVIEW, then import.
 *
 * The preview is not decoration. It is the only place someone sees that a
 * column was ignored, that half the rows are duplicates, or that the import
 * would push the batch past its capacity — before any of it is written.
 */

import { useState } from 'react';
import { STRINGS, type Lang, dirForLang } from '@/lib/i18n';
import type { PaylaterBatchBrief } from '@/lib/platform/paylater';
import { paylaterMonthLabel } from '@/lib/platform/paylaterMonths';

interface Preview {
  batchCode: string;
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  dateFillCount?: number;
  repeatCount?: number;
  repeatSample?: { qid: string | null; nameEn: string | null; inBatch: string }[];
  noQidCount: number;
  ignoredColumns: string[];
  missingColumns: string[];
  overCapacity: boolean;
  capacity: number | null;
  wouldTotal: number;
  duplicateSample: { qid: string | null; nameEn: string | null; inBatch: string }[];
  /** paylaterTestMode — TEMPORARY. True when this account may rehearse. */
  testMode?: boolean;
  /** paylaterTestMode — TEMPORARY. True when this preview counted them in. */
  allowDuplicates?: boolean;
  sample: {
    rowNo: number | null;
    nameEn: string | null;
    nameAr: string | null;
    qid: string | null;
    debtTotal: number | null;
    dpd: number | null;
  }[];
}

export default function ImportExcelModal({
  lang,
  batches,
  onClose,
  onDone,
  inline = false,
  onChanged,
}: {
  lang: Lang;
  /** Only `id`, `code` and `month` are read — the picker shows nothing else,
   * so the counts are not required and callers need not pay to compute them. */
  batches: PaylaterBatchBrief[];
  onClose: () => void;
  onDone: () => void;
  /**
   * v2 puts this on the home page as a SECTION, not behind a button — the
   * month's import is the first thing that happens, so the prototype leaves it
   * open. Rendered inline there is no scrim, no dialog chrome and no close
   * button; everything below is the same markup either way, so the preview
   * cannot drift between the two.
   */
  inline?: boolean;
  /** Called as soon as a commit lands, so the page behind can re-read. */
  onChanged?: () => void;
}) {
  const t = STRINGS[lang];
  const dir = dirForLang(lang);

  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState(batches[0]?.id ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [datesDone, setDatesDone] = useState(0);
  /**
   * paylaterTestMode — TEMPORARY (lib/platform/paylaterTestMode.ts).
   * Off every time the dialog opens: a rehearsal has to be asked for.
   */
  const [allowDuplicates, setAllowDuplicates] = useState(false);

  async function send(mode: 'preview' | 'commit', dupOverride?: boolean) {
    if (!file || !batchId) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set('file', file);
    body.set('batchId', batchId);
    body.set('mode', mode);
    // paylaterTestMode — TEMPORARY. The override is passed in rather than read
    // from state, so ticking the box can re-preview in the same click.
    if (dupOverride ?? allowDuplicates) body.set('allowDuplicates', '1');
    try {
      const res = await fetch('/api/paylater/import', { method: 'POST', body });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        preview?: Preview;
        imported?: number;
        datesFilled?: number;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Could not read that file.');
        setBusy(false);
        return;
      }
      if (mode === 'preview') {
        setPreview(data.preview ?? null);
      } else {
        setDone(data.imported ?? 0);
        setDatesDone(data.datesFilled ?? 0);
        /*
          REFRESH NOW, not when the person navigates away.

          The counts on the folders come from the server render. Only `onDone`
          refreshed them, and that fires on the Back button — so after an import
          the folder sat at "0/100" until somebody opened the batch and came
          back, which reads as the import having failed. The success message
          stays up; only the data behind the page is renewed.
        */
        onChanged?.();
      }
      setBusy(false);
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  const body = (
    <>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        {done !== null ? (
          <>
            <div className="form-success" role="status">
              {t.plImportDone.replace('{n}', String(done))}
              {datesDone > 0 && ' ' + t.plImportDatesFilled.replace('{n}', String(datesDone))}
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="pl-btn p" onClick={onDone}>
                {t.plBack}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="pl-import-batch">{t.plBatch}</label>
              <select
                id="pl-import-batch"
                value={batchId}
                onChange={(e) => {
                  setBatchId(e.target.value);
                  setPreview(null);
                }}
              >
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {paylaterMonthLabel(b.month, lang)}
                  </option>
                ))}
              </select>
            </div>

            {/* v2's chooser: a label styled as a button, the input hidden
                inside it, and the chosen file named beside it. */}
            <div className="field">
              <label htmlFor="pl-import-file">Excel</label>
              <div className="pl-imp">
                <label className="pl-fakebtn">
                  <span>{t.plChooseExcel}</span>
                  <input
                    id="pl-import-file"
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      setPreview(null);
                    }}
                  />
                </label>
                <span className="pl-hint" dir="ltr">
                  {file ? file.name : t.plNoFilesChosen}
                </span>
              </div>
            </div>

            {!preview && (
              <div className="dash-modal-actions">
                <button
                  type="button"
                  className="pl-btn p"
                  disabled={!file || !batchId || busy}
                  onClick={() => send('preview')}
                >
                  {busy ? t.plSaving : t.plImportPreview}
                </button>
              </div>
            )}

            {preview && (
              <>
                <div className="meta-grid">
                  <div>
                    <div className="dash-eyebrow">{t.plImportRows}</div>
                    <div className="dash-strong" dir="ltr">
                      {preview.totalRows}
                    </div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plImportNew}</div>
                    <div className="dash-strong" dir="ltr">
                      {preview.newCount}
                    </div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plImportRepeats}</div>
                    <div className="dash-strong" dir="ltr">
                      {preview.repeatCount ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">
                      {/* paylaterTestMode: the same number means the opposite
                          thing once the box is ticked, so it cannot keep the
                          word "skipped". */}
                      {preview.allowDuplicates
                        ? t.plImportDuplicatesKept
                        : t.plImportDuplicates}
                    </div>
                    <div className="dash-strong" dir="ltr">
                      {preview.duplicateCount}
                    </div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plImportNoQid}</div>
                    <div className="dash-strong" dir="ltr">
                      {preview.noQidCount}
                    </div>
                  </div>
                </div>

                {/* paylaterTestMode — TEMPORARY (lib/platform/paylaterTestMode.ts).
                    Shown only to an admin, only while there are duplicates to
                    ignore, and it re-previews so the counts tell the truth
                    before anything is written. */}
                {preview.testMode && preview.duplicateCount > 0 && (
                  <label
                    className="dash-alert"
                    style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}
                  >
                    <input
                      type="checkbox"
                      checked={allowDuplicates}
                      disabled={busy}
                      onChange={(e) => {
                        setAllowDuplicates(e.target.checked);
                        void send('preview', e.target.checked);
                      }}
                    />
                    <span>{t.plImportAllowDuplicates}</span>
                  </label>
                )}

                {(preview.repeatCount ?? 0) > 0 && (
                  <p className="dash-hint">
                    {t.plImportRepeatNote}
                    {preview.repeatSample?.length ? ' ' : ''}
                    {preview.repeatSample
                      ?.map((d) => `${d.nameEn ?? d.qid} (${d.inBatch})`)
                      .join(lang === 'ar' ? '، ' : ', ')}
                  </p>
                )}

                {/*
                  NOT A CHOICE. The sheet is where the notice date and the case
                  registration date come from — it is the Team Leader's
                  schedule, and the only place either is written down — and this
                  only ever fills a date the file does not already have. There
                  is nothing for a person to decide, so the preview says what
                  will happen rather than asking whether it should.
                */}
                {(preview.dateFillCount ?? 0) > 0 && (
                  <p className="dash-hint">
                    {t.plImportDateFill.replace('{n}', String(preview.dateFillCount))}
                  </p>
                )}

                {preview.overCapacity && (
                  <div className="dash-alert" role="status">
                    {t.plOverCapacity}{' '}
                    <span dir="ltr">
                      {preview.wouldTotal} / {preview.capacity}
                    </span>
                  </div>
                )}

                {preview.missingColumns.length > 0 && (
                  <p className="dash-hint">
                    {lang === 'ar' ? 'أعمدة لم توجد: ' : 'Columns not found: '}
                    <span dir="ltr">{preview.missingColumns.join(', ')}</span>
                  </p>
                )}

                {preview.ignoredColumns.length > 0 && (
                  <p className="dash-hint">
                    {t.plImportIgnored}:{' '}
                    <span dir="ltr">{preview.ignoredColumns.join(', ')}</span>
                  </p>
                )}

                {preview.duplicateSample.length > 0 && (
                  <p className="dash-hint">
                    {lang === 'ar'
                      ? 'أمثلة على المكرر (سيتم تخطيها): '
                      : 'Duplicates that will be skipped: '}
                    <span dir="ltr">
                      {preview.duplicateSample
                        .map((d) => `${d.nameEn ?? d.qid} (${d.inBatch})`)
                        .join(', ')}
                    </span>
                  </p>
                )}

                {preview.sample.length > 0 && (
                  <>
                    <h3 className="dash-title-sm">{t.plImportSample}</h3>
                    <div className="dash-table-wrap">
                      <table className="dash-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>{t.plNameEn}</th>
                            <th>{t.plQid}</th>
                            <th>{t.plDebtTotal}</th>
                            <th>{t.plDpd}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample.map((r, i) => (
                            <tr key={i}>
                              <td dir="ltr">{r.rowNo ?? ''}</td>
                              <td dir="ltr">{r.nameEn ?? ''}</td>
                              <td dir="ltr">{r.qid ?? ''}</td>
                              <td dir="ltr">{r.debtTotal ?? ''}</td>
                              <td dir="ltr">{r.dpd ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                <div className="dash-modal-actions">
                  <button type="button" className="pl-btn" onClick={onClose}>
                    {t.plBack}
                  </button>
                  <button
                    type="button"
                    className="pl-btn p"
                    // Live when there is anything to do at all. A sheet that is all
                    // repeats of files already here still carries the notice
                    // and case dates those files are missing, and refusing to
                    // run left that the one thing the import could not do.
                    disabled={
                      busy ||
                      (preview.newCount === 0 && (preview.dateFillCount ?? 0) === 0)
                    }
                    onClick={() => send('commit')}
                  >
                    {busy ? t.plSaving : t.plImportConfirm}
                  </button>
                </div>
              </>
            )}
          </>
        )}
    </>
  );

  if (inline) return <div className="dash-card" dir={dir}>{body}</div>;

  return (
    /*
      THE MODAL MUST BE A CHILD OF THE SCRIM, not its sibling. `.dash-modal-scrim`
      is the fixed, full-screen, scrolling flex container that centres the
      dialog; `.dash-modal` carries no positioning of its own. Rendered as
      siblings the scrim covered the screen and the dialog stayed a static block
      in the document flow — it landed below the batch grid with its Preview
      button off the bottom of the window.
    */
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      dir={dir}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dash-modal">
        <div className="dash-modal-head">
          <h2 className="dash-title-sm">{t.plImportExcel}</h2>
          <button type="button" className="dash-modal-close" onClick={onClose} aria-label={t.plBack}>
            ×
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
