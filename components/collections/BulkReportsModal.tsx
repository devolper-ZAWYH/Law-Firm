'use client';

/**
 * READ A WHOLE BATCH OF REPORTS FROM ONE ZIP.
 *
 * The month arrives as a folder per customer, each holding that customer's
 * report PDF and a photograph of their ID card. This replaces opening a hundred
 * files and uploading two documents into each.
 *
 * THE UNZIPPING AND PARSING HAPPEN IN THE BROWSER, and that is not a stylistic
 * choice: a batch of reports is ~59 MB and no serverless request will carry it.
 * Each report is posted on its own to the same extract route the single-file
 * upload uses — already validated against 73 real reports — so there is one
 * parser, not two. What reaches the server for matching is the parsed data,
 * which is small.
 *
 * MATCHING IS BY THE QID INSIDE THE PDF, not the folder name. A folder name is
 * something somebody typed; the QID in the report is the document the notice is
 * built from.
 *
 * A REPORT FOR A CUSTOMER IN ANOTHER BATCH IS NEVER APPLIED SILENTLY. Repeat
 * customers do occur — five in a hundred, in the batch this was built against.
 * Each one is shown with the customer's name, batch, row, claim and stage, and
 * is filled in only when the person uploading confirms that specific customer.
 * No file is ever moved between batches.
 */

import { useState } from 'react';
import { usePaylaterLang } from './PaylaterShell';
import type { PaylaterBatchBrief } from '@/lib/platform/paylater';
import { paylaterMonthLabel } from '@/lib/platform/paylaterMonths';

interface Match {
  qid: string;
  customerId: string;
  nameAr: string | null;
  nameEn: string | null;
  batchCode: string;
  rowNo: number | null;
  outstanding: number | null;
  stage: string | null;
  bucket: string | null;
  nationality: string | null;
  orders: number;
}

interface Preview {
  batchCode: string;
  inBatch: Match[];
  crossBatch: Match[];
  unmatched: string[];
  missing: { qid: string | null; nameEn: string | null; rowNo: number | null }[];
  applied: number;
  kept: string[];
}

/** One customer's folder, as found inside the ZIP. */
interface Entry {
  folder: string;
  report?: { name: string; blob: Blob };
  card?: { name: string; blob: Blob };
}

/**
 * A PERCENTAGE AND A TIME THAT ARE BOTH MEASURED.
 *
 * The bar reports what has actually finished, and the remaining time comes from
 * how long THIS run has taken so far: elapsed ÷ done × what is left. Nothing is
 * assumed about how fast a report parses, because that depends on the machine
 * and the connection in front of the person waiting.
 *
 * It says nothing until three items are done. An estimate drawn from one sample
 * swings from "four minutes" to "forty seconds" between ticks, and a number
 * that jumps like that is worse than no number — people stop believing the bar
 * and sit watching it anyway.
 */
function Progress({
  p,
  t,
  lang,
}: {
  p: { done: number; total: number; startedAt: number };
  t: { plBulkReading: string; plProgressLeft: string; plProgressAlmost: string };
  lang: 'ar' | 'en';
}) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const elapsed = Date.now() - p.startedAt;
  const left =
    p.done >= 3 && p.done < p.total
      ? Math.round(((elapsed / p.done) * (p.total - p.done)) / 1000)
      : null;

  const time =
    left === null
      ? ''
      : left < 5
        ? t.plProgressAlmost
        : t.plProgressLeft.replace(
            '{t}',
            left < 60
              ? `${left}s`
              : `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s`
          );

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: 'var(--rail, #F6F5F1)',
          overflow: 'hidden',
        }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--albaker-gold)',
            transition: 'width .2s linear',
          }}
        />
      </div>
      <p className="dash-hint" style={{ marginTop: 6 }}>
        <span dir="ltr">{pct}%</span>
        {' · '}
        {t.plBulkReading
          .replace('{done}', String(p.done))
          .replace('{total}', String(p.total))}
        {time && (
          <>
            {' · '}
            <span dir={lang === 'ar' ? undefined : 'ltr'}>{time}</span>
          </>
        )}
      </p>
    </div>
  );
}

export default function BulkReportsModal({
  batches,
  defaultBatchId,
  onClose,
  onDone,
}: {
  /** Only `id`, `code` and `month` are read — the picker shows nothing else,
   * so the counts are not required and callers need not pay to compute them. */
  batches: PaylaterBatchBrief[];
  defaultBatchId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { lang, t, dir } = usePaylaterLang();

  const [batchId, setBatchId] = useState(defaultBatchId ?? batches[0]?.id ?? '');
  const [overwrite, setOverwrite] = useState(false);
  const [attachCards, setAttachCards] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * done/total plus the moment the phase began. The remaining time is measured
   * from THIS run — how long the reports actually took so far — because a
   * hundred reports on a laptop and a hundred on the office connection are not
   * the same job, and an estimate from anything other than the work in front of
   * you is a decoration.
   */
  const [progress, setProgress] = useState<
    { done: number; total: number; startedAt: number } | null
  >(null);

  /** Starts a phase, or advances it. `total` fixes the denominator. */
  const step = (done: number, total: number) =>
    setProgress((p) =>
      p && p.total === total
        ? { ...p, done }
        : { done, total, startedAt: Date.now() }
    );
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<number | null>(null);
  /** ID cards that could not be attached, reported beside the applied count. */
  const [failedCards, setFailedCards] = useState(0);

  /** qid → the parsed report and the card blob, kept for the commit step. */
  const [parsed, setParsed] = useState<
    Map<
      string,
      { extracted: Record<string, unknown>; customerId?: string; card?: Blob; fileNo?: string }
    >
  >(new Map());

  async function readZip(file: File) {
    setBusy(true);
    setError(null);
    setPreview(null);
    setDone(null);
    setConfirmed(new Set());
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(file);

      // Group the entries by their containing folder. A customer's folder holds
      // the report and the card; which is which is decided by the file name,
      // falling back to "the PDF that is not the card".
      const folders = new Map<string, Entry>();
      const files = Object.values(zip.files).filter((f) => !f.dir);
      for (const f of files) {
        if (!/\.(pdf|jpe?g|png|webp)$/i.test(f.name)) continue;
        const parts = f.name.split('/');
        const folder = parts.slice(0, -1).join('/') || '(root)';
        const base = parts[parts.length - 1].toLowerCase();
        if (base.startsWith('.') || base.startsWith('__macosx')) continue;
        const e = folders.get(folder) ?? { folder };
        const blob = await f.async('blob');
        if (/qid|card|bataqa|هوية/i.test(base)) e.card = { name: base, blob };
        else if (base.endsWith('.pdf')) e.report = { name: base, blob };
        folders.set(folder, e);
      }

      const withReport = [...folders.values()].filter((e) => e.report);
      if (withReport.length === 0) {
        setError(t.plBulkNoZip);
        setBusy(false);
        return;
      }

      /*
        Parse each report through the SAME route the single upload uses, but
        SIX AT A TIME.

        One at a time, a report costs ~650ms of which almost all is the server
        reading the PDF; the browser spends that time idle. A hundred reports
        was a minute of watching a progress bar for work that does not depend on
        itself — each report is independent. Six keeps every request small
        enough to stay well inside a function's limits while the wall-clock
        drops to roughly a sixth, and it is low enough not to look like a flood
        to the platform.
      */
      /*
        THE FILE NUMBER IS THE NUMBER ON THE FOLDER.

        A customer's folder is named "001- <QID> <CUSTOMER NAME>", and that
        leading 001 IS the file number the firm works to — it is on the
        physical file and in the Progress Report. The portal was deriving its own
        from QID order, which agrees with the folder often enough to look right
        and not always, and disagreeing about a file number is the kind of error
        that is only noticed in a courtroom.

        Taken from the LAST path segment before the files, and only when the
        folder actually starts with digits.
      */
      const map = new Map<
        string,
        { extracted: Record<string, unknown>; card?: Blob; fileNo?: string }
      >();
      const items: { qid: string; extracted: unknown; fileNo?: string }[] = [];
      let done = 0;
      let next = 0;

      const worker = async () => {
        for (;;) {
          const idx = next++;
          if (idx >= withReport.length) return;
          const e = withReport[idx];
          const body = new FormData();
          body.set('file', new File([e.report!.blob], e.report!.name, { type: 'application/pdf' }));
          try {
            const res = await fetch('/api/paylater/extract', { method: 'POST', body });
            const d = (await res.json().catch(() => ({}))) as {
              ok?: boolean; extracted?: { qid?: string | null };
            };
            if (res.ok && d.ok && d.extracted?.qid) {
              const qid = String(d.extracted.qid);
              const leaf = e.folder.split('/').filter(Boolean).pop() ?? '';
              const fileNo = leaf.match(/^\s*(\d{1,4})\b/)?.[1];
              // Both writes land from one worker at a time — JS is single
              // threaded between awaits, so no lock is needed here.
              map.set(qid, {
                extracted: d.extracted as Record<string, unknown>,
                card: e.card?.blob,
                fileNo,
              });
              items.push({ qid, extracted: d.extracted, fileNo });
            }
          } catch {
            // A report that will not parse is reported as unmatched later
            // rather than stopping the other ninety-nine.
          }
          step(++done, withReport.length);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(6, withReport.length) }, worker)
      );
      setParsed(map);
      setProgress(null);

      const res = await fetch('/api/paylater/bulk-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', batchId, items }),
      });
      const d = (await res.json().catch(() => ({}))) as Preview & { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? 'Could not match those reports.');
        setBusy(false);
        return;
      }
      setPreview(d);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that ZIP.');
      setBusy(false);
      setProgress(null);
    }
  }

  /**
   * COMMITTED IN CHUNKS, not in one request.
   *
   * A whole batch is ~70 customers and each one writes its orders and its
   * record; done in a single call that took about two minutes, which no
   * serverless platform will hold open — Vercel cuts a function off long before
   * that. Ten at a time keeps every request short, survives a failure without
   * losing the ones already applied, and is what makes the progress bar honest.
   */
  const CHUNK = 10;

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const targets = [
        ...preview.inBatch,
        ...preview.crossBatch.filter((c) => confirmed.has(c.qid)),
      ];
      const items = targets
        .map((m) => {
          const p = parsed.get(m.qid);
          return p ? { qid: m.qid, extracted: p.extracted, fileNo: p.fileNo } : null;
        })
        .filter(Boolean) as {
        qid: string;
        extracted: Record<string, unknown>;
        fileNo?: string;
      }[];

      let applied = 0;
      for (let i = 0; i < items.length; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK);
        step(Math.min(i + CHUNK, items.length), items.length);
        const res = await fetch('/api/paylater/bulk-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'commit', batchId, items: slice, overwrite,
            confirmed: [...confirmed],
          }),
        });
        const d = (await res.json().catch(() => ({}))) as {
          ok?: boolean; error?: string; applied?: number;
        };
        if (!res.ok || !d.ok) {
          setError(d.error ?? 'Could not apply those reports.');
          setBusy(false);
          setProgress(null);
          return;
        }
        applied += d.applied ?? 0;
      }
      setProgress(null);

      // The ID cards go up after the data has landed — a failed attachment must
      // not cost the extraction that already succeeded. A card that does not go
      // up is COUNTED and reported: swallowing it leaves someone believing every
      // file has its ID attached when some do not, which is worse than a number.
      let cardFails = 0;
      if (attachCards) {
        // Four at a time, for the same reason the parsing runs six at a time:
        // an upload is mostly waiting, and the cards are independent of each
        // other. Fewer than six because each one carries a whole image.
        let sent = 0;
        let nextCard = 0;
        const uploader = async () => {
          for (;;) {
            const idx = nextCard++;
            if (idx >= targets.length) return;
            const m = targets[idx];
            const card = parsed.get(m.qid)?.card;
            step(++sent, targets.length);
            if (!card) continue;
            const fd = new FormData();
            fd.set('file', new File([card], 'qid_card.pdf', { type: 'application/pdf' }));
            fd.set('customerId', m.customerId);
            fd.set('kind', 'qid');
            const ok = await fetch('/api/paylater/documents', { method: 'POST', body: fd })
              .then((r) => r.ok)
              .catch(() => false);
            if (!ok) cardFails++;
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, uploader));
        setProgress(null);
      }
      setFailedCards(cardFails);

      setDone(applied);
      setBusy(false);
    } catch {
      setError('Network error.');
      setBusy(false);
      setProgress(null);
    }
  }

  const Row = ({ m }: { m: Match }) => (
    <tr>
      <td dir="ltr">{m.rowNo ?? ''}</td>
      <td>{m.nameAr || ''}</td>
      <td dir="ltr">{m.nameEn || ''}</td>
      <td dir="ltr">{m.qid}</td>
      <td dir="ltr">{m.batchCode}</td>
      <td dir="ltr">
        {m.outstanding === null ? '' : m.outstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}
      </td>
      <td dir="ltr">{m.orders}</td>
    </tr>
  );

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      dir={dir}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dash-modal" style={{ maxInlineSize: 900 }}>
        <div className="dash-modal-head">
          <h2 className="dash-title-sm">{t.plBulkTitle}</h2>
          <button type="button" className="dash-modal-close" onClick={onClose} aria-label={t.plBack}>×</button>
        </div>

        <p className="dash-hint">{t.plBulkIntro}</p>
        {error && <div className="form-error" role="alert">{error}</div>}

        {done !== null ? (
          <>
            <div className="form-success" role="status">
              {t.plBulkApplied.replace('{n}', String(done))}
            </div>
            {failedCards > 0 && (
              <div className="form-error" role="alert">
                {t.plBulkCardsFailed.replace('{n}', String(failedCards))}
              </div>
            )}
            <div className="dash-modal-actions">
              <button type="button" className="pl-btn p" onClick={onDone}>{t.plBack}</button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="pl-bulk-batch">{t.plBatch}</label>
              <select id="pl-bulk-batch" value={batchId}
                onChange={(e) => { setBatchId(e.target.value); setPreview(null); }}>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {paylaterMonthLabel(b.month, lang)}
                  </option>
                ))}
              </select>
            </div>

            {!preview && (
              <div className="field">
                <label htmlFor="pl-bulk-zip">{t.plBulkChoose}</label>
                <input id="pl-bulk-zip" type="file" accept=".zip,application/zip"
                  disabled={busy}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) readZip(f); e.target.value = ''; }} />
              </div>
            )}

            <label className="dash-hint" style={{ display: 'block' }}>
              <input type="checkbox" checked={attachCards}
                onChange={(e) => setAttachCards(e.target.checked)} /> {t.plBulkAttach}
            </label>
            <label className="dash-hint" style={{ display: 'block' }}>
              <input type="checkbox" checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)} /> {t.plExtractOverwrite}
            </label>

            {progress && <Progress p={progress} t={t} lang={lang} />}

            {preview && (
              <>
                <div className="meta-grid" style={{ marginTop: 12 }}>
                  <div>
                    <div className="dash-eyebrow">{t.plBulkMatched}</div>
                    <div className="dash-strong" dir="ltr">{preview.inBatch.length}</div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plBulkCross}</div>
                    <div className="dash-strong" dir="ltr">{preview.crossBatch.length}</div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plBulkUnmatched}</div>
                    <div className="dash-strong" dir="ltr">{preview.unmatched.length}</div>
                  </div>
                  <div>
                    <div className="dash-eyebrow">{t.plBulkMissing}</div>
                    <div className="dash-strong" dir="ltr">{preview.missing.length}</div>
                  </div>
                </div>

                {preview.inBatch.length > 0 && (
                  <>
                    <h3 className="dash-title-sm">{t.plBulkMatched}</h3>
                    <div className="dash-table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
                      <table className="dash-table">
                        <thead><tr>
                          <th>#</th><th>{t.plNameAr}</th><th>{t.plNameEn}</th>
                          <th>{t.plQid}</th><th>{t.plBatch}</th><th>{t.plOutstanding}</th><th>{t.plOrders}</th>
                        </tr></thead>
                        <tbody>{preview.inBatch.map((m) => <Row key={m.qid} m={m} />)}</tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* Each of these needs its own yes. */}
                {preview.crossBatch.length > 0 && (
                  <>
                    <h3 className="dash-title-sm">{t.plBulkCross}</h3>
                    <div className="dash-alert" role="status">{t.plBulkCrossNote}</div>
                    {preview.crossBatch.map((m) => (
                      <div className="dash-card" key={m.qid} style={{ marginBottom: 8 }}>
                        <div className="meta-grid">
                          <div><div className="dash-eyebrow">{t.plNameAr}</div><div>{m.nameAr || '—'}</div></div>
                          <div><div className="dash-eyebrow">{t.plNameEn}</div><div dir="ltr">{m.nameEn || '—'}</div></div>
                          <div><div className="dash-eyebrow">{t.plQid}</div><div dir="ltr">{m.qid}</div></div>
                          <div><div className="dash-eyebrow">{t.plBatch}</div><div dir="ltr">{m.batchCode} · #{m.rowNo}</div></div>
                          <div><div className="dash-eyebrow">{t.plOutstanding}</div><div dir="ltr">
                            {m.outstanding === null ? '—' : m.outstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </div></div>
                          <div><div className="dash-eyebrow">{t.plStage}</div><div dir="ltr">{m.stage || '—'}</div></div>
                        </div>
                        {confirmed.has(m.qid) ? (
                          <span className="dash-pill dash-pill-green">{t.plBulkConfirmed}</span>
                        ) : (
                          <button type="button" className="pl-btn"
                            onClick={() => setConfirmed((p) => new Set(p).add(m.qid))}>
                            {t.plBulkConfirmThis}
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}

                {preview.missing.length > 0 && (
                  <p className="dash-hint">
                    <strong>{t.plBulkMissing}:</strong>{' '}
                    <span dir="ltr">
                      {preview.missing.slice(0, 12).map((m) => m.rowNo ?? m.qid).join(', ')}
                      {preview.missing.length > 12 ? ` … +${preview.missing.length - 12}` : ''}
                    </span>
                  </p>
                )}
                {preview.unmatched.length > 0 && (
                  <p className="dash-hint">
                    <strong>{t.plBulkUnmatched}:</strong>{' '}
                    <span dir="ltr">{preview.unmatched.slice(0, 12).join(', ')}</span>
                  </p>
                )}

                <div className="dash-modal-actions">
                  <button type="button" className="pl-btn" onClick={onClose}>{t.plBack}</button>
                  <button type="button" className="pl-btn p" disabled={busy}
                    onClick={commit}>
                    {busy ? t.plSaving : `${t.plBulkApply} (${preview.inBatch.length + confirmed.size})`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
