'use client';

/**
 * The PayLater dashboard — v2's batch folders, with the month's Excel import.
 *
 * Each folder shows its file count and, when any are still incomplete, how many
 * — that count is the month's actual progress bar. An Excel-imported customer
 * is incomplete by definition (order detail lives only in the PDF reports), so
 * "incomplete → 0" is what the intake work is driving toward.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePaylaterLang } from './PaylaterShell';
import type { PaylaterBatch } from '@/lib/platform/paylater';
import {
  PAYLATER_MONTHS,
  paylaterMonthLabel,
} from '@/lib/platform/paylaterMonths';
import ImportExcelModal from './ImportExcelModal';

/** Numbers stay LTR inside an RTL paragraph — see the note in lib/i18n.ts. */
function Num({ value, decimals = 0 }: { value: number; decimals?: number }) {
  return (
    <span dir="ltr">
      {value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}

/**
 * v2's folder glyph, at v2's size. The colour is the batch's state: grey while
 * it is empty, orange while it is filling, gold once it holds its capacity —
 * which is the whole point of the home page being a wall of folders rather
 * than a list of names.
 */
function FolderIcon({ colour }: { colour: string }) {
  return (
    <svg viewBox="0 0 46 38" fill="none" aria-hidden="true">
      <path
        d="M2 8a4 4 0 014-4h11l4 5h17a4 4 0 014 4v21a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"
        fill={colour}
      />
    </svg>
  );
}

export default function PaylaterDashboard({
  batches,
  canLead,
}: {
  batches: PaylaterBatch[];
  canLead: boolean;
}) {
  // One language for the whole portal, owned by the shell.
  const { lang, t, dir } = usePaylaterLang();
  const router = useRouter();

  const [showNewBatch, setShowNewBatch] = useState(false);
  const [code, setCode] = useState('');
  const [month, setMonth] = useState('');
  const [capacity, setCapacity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(
    () => ({
      files: batches.reduce((s, b) => s + b.fileCount, 0),
      incomplete: batches.reduce((s, b) => s + b.incompleteCount, 0),
      batches: batches.length,
    }),
    [batches]
  );

  async function createBatch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paylater/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          month: month.trim(),
          capacity: capacity.trim() ? Number(capacity) : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Could not create the batch.');
        setBusy(false);
        return;
      }
      setShowNewBatch(false);
      setCode('');
      setMonth('');
      setCapacity('');
      setBusy(false);
      router.refresh();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  return (
    <div dir={dir}>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.plPortal}</h1>
          <p className="dash-subtitle">{t.plSubtitle}</p>
        </div>
        {canLead && (
          <div className="dash-actions">
            <button
              type="button"
              className="pl-btn"
              onClick={() => setShowNewBatch((v) => !v)}
            >
              {t.plNewBatch}
            </button>
          </div>
        )}
      </div>

      {/* Totals */}
      <div className="files-grid" style={{ marginBottom: '1.25rem' }}>
        <div className="dash-card">
          <div className="dash-eyebrow">{t.plBatches}</div>
          <div className="dash-value">
            <Num value={totals.batches} />
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-eyebrow">{t.plFiles}</div>
          <div className="dash-value">
            <Num value={totals.files} />
          </div>
        </div>
        {/*
          Red, like the per-file chips. Intake is not optional work — a file
          without it cannot produce a notice — so the count of files still
          waiting is a problem to clear, not a statistic. Zero is shown plainly:
          nothing outstanding is not an error.
        */}
        <div className="dash-card" title={t.plIntakeExplained}>
          <div className="dash-eyebrow">{t.plIntakePending}</div>
          <div className={`dash-value${totals.incomplete > 0 ? ' is-danger' : ''}`}>
            <Num value={totals.incomplete} />
          </div>
        </div>
      </div>

      {showNewBatch && canLead && (
        <form className="dash-card" onSubmit={createBatch} style={{ marginBottom: '1.25rem' }}>
          <h2 className="dash-title-sm">{t.plNewBatch}</h2>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="grid-2">
            <div className="field">
              <label htmlFor="pl-code">{t.plBatchCode}</label>
              <input
                id="pl-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="F100"
                dir="ltr"
                required
              />
            </div>
            {/*
              A SELECT, not a free-text field. The month is the batch's label
              everywhere it appears, and it is stored as the uppercase English
              name the firm's Progress Report uses — so a typo would not just
              look wrong, it would create a second spelling of a month that the
              seven imported batches already carry. Twelve known values; there
              is nothing here to type.
            */}
            <div className="field">
              <label htmlFor="pl-month">{t.plMonth}</label>
              <select
                id="pl-month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                required
              >
                <option value="">—</option>
                {PAYLATER_MONTHS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {lang === 'ar' ? m.ar : m.en}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-cap">{t.plCapacity}</label>
              <input
                id="pl-cap"
                type="number"
                min="1"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                dir="ltr"
              />
            </div>
          </div>
          <button className="pl-btn p" type="submit" disabled={busy}>
            {busy ? t.plSaving : t.plCreateBatch}
          </button>
        </form>
      )}

      {/*
        v2 keeps the month's import OPEN on the home page as its own section,
        because importing the batch is the first thing that happens each month
        — it is not an action hidden behind a button.
      */}
      {canLead && (
        <>
          <div className="pl-sechead" style={{ marginTop: 18 }}>
            <span className="sq" />
            <h2>{t.plImportExcel}</h2>
          </div>
          <ImportExcelModal
            inline
            lang={lang}
            batches={batches}
            onClose={() => router.refresh()}
            onDone={() => router.refresh()}
            onChanged={() => router.refresh()}
          />
        </>
      )}

      {/* Batch folders */}
      <div className="pl-sechead" style={{ marginTop: 18 }}>
        <span className="sq" />
        <h2>{t.plFolders}</h2>
        <span className="pl-pill" dir="ltr">{totals.files.toLocaleString('en-US')}</span>
      </div>
      {batches.length === 0 ? (
        <div className="dash-state-card">{t.plNoBatches}</div>
      ) : (
        <div className="pl-folders">
          {batches.map((b) => (
            <a key={b.id} className="pl-folder" href={`/collections/batch/${b.id}`}>
              {/*
                THE BADGE COUNTS WHAT NEEDS DOING, not how many files there are.

                v2 put the file count here, in red, in the corner — and a red
                number in a corner is read as "this many problems". On a folder
                holding 3 files of which 2 need data it said "3" beside a line
                saying "2 Needs data", and the two numbers disagreed about
                nothing. The file count was never missing: it is in the line
                below, as "3/100".
              */}
              {b.incompleteCount > 0 && (
                <span className="badge" dir="ltr" title={t.plIntakeExplained}>
                  {b.incompleteCount}
                </span>
              )}
              <FolderIcon
                colour={
                  b.fileCount === 0
                    ? '#C9C5BE'
                    : b.capacity !== null && b.fileCount >= b.capacity
                      ? '#D9B23F'
                      : '#D07B34'
                }
              />
              <div className="code" dir="ltr">{b.code}</div>
              <div className="meta">
                {paylaterMonthLabel(b.month, lang)}
                {' · '}
                {/*
                  ONE ltr span for the whole fraction. Split in two it reorders
                  inside the RTL card — "100 / 100" renders as "/ 100" over
                  "100". See the i18n note in CLAUDE.md.
                */}
                <span dir="ltr" style={{ whiteSpace: 'nowrap' }}>
                  {b.fileCount.toLocaleString('en-US')}
                  {b.capacity ? `/${b.capacity.toLocaleString('en-US')}` : ''}
                </span>
                {b.incompleteCount > 0 && (
                  <>
                    <br />
                    <span className="miss" title={t.plIntakeExplained}>
                      {t.plStatusNeedsData}
                    </span>
                  </>
                )}
              </div>
            </a>
          ))}
        </div>
      )}

    </div>
  );
}
