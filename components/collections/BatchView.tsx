'use client';

/**
 * A batch's files — v2's batch screen.
 *
 * THE MULTI-SELECT IS THE NOTICE-DAY ASSIGNMENT. The firm sends roughly fifteen
 * notices a day across a batch, so the working motion is "select these fifteen,
 * give them Sunday's date". A checkbox per row and a select-all in the header
 * open a bar carrying both dates; filling either or both applies to the whole
 * selection in one write.
 *
 * The table scrolls inside `.dash-table-wrap`, never the page — the house rule
 * for wide content.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
// paylaterTestMode — TEMPORARY, see lib/platform/paylaterTestMode.ts
import { usePaylaterLang } from './PaylaterShell';
import type { Strings } from '@/lib/i18n';
import type { PaylaterCustomerRow, PaylaterBatchBrief } from '@/lib/platform/paylater';
import { paylaterMonthLabel } from '@/lib/platform/paylaterMonths';
import BulkReportsModal from './BulkReportsModal';
import Toast, { type ToastMessage } from './Toast';
import CustomerDrawer from './CustomerDrawer';
import { missingIntakeParts, type IntakePart } from '@/lib/platform/paylaterIntake';
import { formatMoney } from '@/lib/platform/paylaterMoney';
import {
  documentCount,
  normaliseNationality,
  NATIONALITIES,
} from '@/lib/platform/paylaterDerive';

/** Two decimals with the currency, LTR, or an empty cell — never "null". */
/**
 * The file's OWN currency, not a constant: a row shows the unit its report
 * stated (#38). Rows that predate the column read QAR, which is what they are.
 */
const money = (v: number | null, lang: 'ar' | 'en', code: string) =>
  formatMoney(v, lang, code);

/**
 * The nationality as v2 writes it: Arabic name in Arabic, the stored English
 * key in English. An unrecognised value shows itself rather than vanishing —
 * the same rule the stage and bucket labels follow.
 */
function nationalityLabel(raw: string | null, lang: 'ar' | 'en'): string {
  if (!raw) return '';
  const key = normaliseNationality(raw);
  if (!key) return raw;
  return lang === 'ar' ? NATIONALITIES[key][0] : key;
}

export interface BatchRow extends PaylaterCustomerRow {
  fileNo: string;
  fileNoManual: boolean;
}

/** Stage and bucket labels, bilingual. The values are the ones in the data. */
const STAGE_LABELS: Record<string, [string, string]> = {
  notice_planned: ['إنذار مخطط', 'Notice planned'],
  notice_sent: ['أُرسل الإنذار', 'Notice sent'],
  case_filed: ['قُيدت الدعوى', 'Case filed'],
  awaiting_hearing: ['بانتظار الجلسة', 'Awaiting hearing'],
  judgment: ['صدر الحكم', 'Judgment'],
  paid_after_judgment: ['سداد بعد الحكم', 'Paid after judgment'],
  settled_pre_case: ['تسوية قبل الدعوى', 'Settled pre-case'],
  settled_post_case: ['تسوية بعد الدعوى', 'Settled post-case'],
  enforcement: ['تنفيذ', 'Enforcement'],
};

const BUCKET_LABELS: Record<string, [string, string]> = {
  settlement: ['ملف التسوية', 'Settlement'],
  pre_enforcement: ['قبل التنفيذ', 'Pre-enforcement'],
  enforcement: ['التنفيذ', 'Enforcement'],
  archived: ['ملف الحفظ', 'Archived'],
};

/** How each missing intake part is named. */
const MISSING_LABEL: Record<IntakePart, (t: Strings) => string> = {
  gender: (t) => t.plMissGender,
  reportDate: (t) => t.plMissReportDate,
  regDate: (t) => t.plMissRegDate,
  orders: (t) => t.plMissOrders,
};

/** The numeric columns, and how each one compares. */
type SortKey = 'fileNo' | 'qid' | 'outstanding' | 'debtTotal' | 'orderCount';

const SORT_VALUE: Record<SortKey, (r: BatchRow) => number | string | null> = {
  // Zero-padded already ("001"), so lexical order equals numeric order.
  fileNo: (r) => r.fileNo || null,
  // Padded to a common width rather than parsed as a number: QIDs carry a
  // leading zero (B100 #23 is "045112026") that Number() would destroy, and
  // they differ in length across batches.
  qid: (r) => (r.qid ? r.qid.padStart(12, '0') : null),
  outstanding: (r) => r.outstanding,
  debtTotal: (r) => r.debtTotal,
  orderCount: (r) => r.orderCount,
};

export default function BatchView({
  batch,
  batches,
  rows,
  canLead,
  canEditFiles,
  canDeleteFiles,
  canDeleteBatch,
  assignable,
  currentUserId,
}: {
  batch: { id: string; code: string; month: string; capacity: number | null };
  /** Every batch, for the bulk-reports picker. */
  /** Passed straight through to the bulk-reports picker, which reads only
   * `id`, `code` and `month`. */
  batches: PaylaterBatchBrief[];
  rows: BatchRow[];
  canLead: boolean;
  /** Employees and Team Leaders prepare files; lawyers and auditors do not. */
  canEditFiles: boolean;
  /** May remove a customer file — canEditFiles, or an admin regardless. */
  canDeleteFiles: boolean;
  /** Removing a batch is admin-only, and only ever an empty one. */
  canDeleteBatch: boolean;
  /** Who a Team Leader may hand files to (¶22). */
  assignable: { userId: string; name: string; role: string }[];
  currentUserId: string;
}) {
  // One language for the whole portal, owned by the shell.
  const { lang, t, dir } = usePaylaterLang();
  const router = useRouter();
  /** The file open in the drawer, or null. Opening one no longer navigates. */
  const [openCustomerId, setOpenCustomerId] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noticeDate, setNoticeDate] = useState('');
  const [caseRegDate, setCaseRegDate] = useState('');
  const [assignee, setAssignee] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Step 7 of the journey is done by "the employee responsible for the relevant
  // batch", so an employee needs to see their own files without reading past
  // everyone else's.
  const [mineOnly, setMineOnly] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  /** The centred, self-dismissing reply. See components/collections/Toast.tsx. */
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const say = (text: string, kind: 'ok' | 'err') =>
    setToast({ text, kind, at: Date.now() });

  /**
   * SORTING, on the numeric columns only.
   *
   * Three states per column — ascending, descending, then back to the batch's
   * own order. The third is not a nicety: row_no is the numbering the firm's
   * Progress Report uses, so being able to get back to it after sorting by
   * claim is how someone reconciles what they are looking at with the report.
   */
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(
    null
  );

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click restores the batch's own order
    });
  }

  const mineCount = useMemo(
    () => rows.filter((r) => r.assignedTo === currentUserId).length,
    [rows, currentUserId]
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows;
    if (mineOnly) out = out.filter((r) => r.assignedTo === currentUserId);
    if (q) {
      out = out.filter(
        (r) =>
          (r.nameEn ?? '').toLowerCase().includes(q) ||
          (r.nameAr ?? '').includes(query.trim()) ||
          (r.qid ?? '').includes(q) ||
          (r.caseNumber ?? '').toLowerCase().includes(q)
      );
    }
    if (!sort) return out;

    const dir = sort.dir === 'asc' ? 1 : -1;
    // Copy before sorting — Array.sort mutates, and `rows` is a prop.
    return [...out].sort((a, b) => {
      const x = SORT_VALUE[sort.key](a);
      const y = SORT_VALUE[sort.key](b);
      // A missing value sorts LAST in both directions. A file with no claim
      // recorded is not the smallest claim; flipping it to the top on the first
      // click would read as "these are the cheapest", which is a wrong answer.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }, [rows, query, mineOnly, currentUserId, sort]);

  const allShownSelected =
    shown.length > 0 && shown.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) {
        for (const r of shown) next.delete(r.id);
      } else {
        for (const r of shown) next.add(r.id);
      }
      return next;
    });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function applyDates() {
    if (selected.size === 0) return;
    if (!noticeDate && !caseRegDate && assignee === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paylater/bulk-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          noticePlanned: noticeDate || null,
          caseRegDate: caseRegDate || null,
          // Omitted entirely when untouched, so "apply these dates" does not
          // silently unassign the files it touches.
          ...(assignee === '' ? {} : { assignedTo: assignee === '__none__' ? null : assignee }),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Could not apply those dates.');
        say(data.error ?? 'Could not apply those dates.', 'err');
        setBusy(false);
        return;
      }
      say(t.plApplied.replace('{n}', String(selected.size)), 'ok');
      setSelected(new Set());
      setNoticeDate('');
      setCaseRegDate('');
      setAssignee('');
      setBusy(false);
      router.refresh();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  async function deleteBatch(force = false) {
    if (force) {
      /*
        TYPE THE CODE. A single OK on a confirm dialog deleted E100 — a hundred
        real client files with their orders, notices and ID cards — because the
        button sits beside two harmless ones and the dialog reads like every
        other dialog. Making someone WRITE the batch code is the difference
        between an accident and a decision: a wrong click cannot produce
        "E100", and a person who types it has read which batch they are on.
      */
      const typed = window.prompt(
        t.plDeleteBatchForceConfirm
          .replace('{n}', String(rows.length))
          .replace('{code}', batch.code)
      );
      if (typed?.trim().toUpperCase() !== batch.code.toUpperCase()) {
        if (typed !== null) setError(t.plDeleteBatchForceMismatch);
        return;
      }
    } else if (!window.confirm(t.plDeleteBatchConfirm)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/paylater/batches/${batch.id}${force ? '?force=1' : ''}`,
        { method: 'DELETE' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t.plDeleteBatchBlocked);
        setBusy(false);
        return;
      }
      // The batch is gone — there is no page left to refresh.
      window.location.assign('/collections');
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  const label = (m: Record<string, [string, string]>, key: string | null) => {
    if (!key) return '';
    const pair = m[key];
    if (!pair) return key; // an unmapped value shows itself rather than vanishing
    return lang === 'ar' ? pair[0] : pair[1];
  };

  return (
    <div dir={dir}>
      <div className="dash-page-head">
        <div>
          <a className="dash-back" href="/collections">
            {/* Mirrors under RTL — a literal arrow does not. */}
            <span className="cal-nav-arrow" aria-hidden="true">
              ←
            </span>{' '}
            {t.plBack}
          </a>
          <h1 className="dash-title">
            <span dir="ltr">{batch.code}</span>
          </h1>
          <p className="dash-subtitle">
            <span dir={lang === 'ar' ? undefined : 'ltr'}>
              {paylaterMonthLabel(batch.month, lang)}
            </span>{' '}
            · {t.plFiles}:{' '}
            <span dir="ltr">{rows.length}</span>
            {batch.capacity ? (
              <>
                {' / '}
                <span dir="ltr">{batch.capacity}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="dash-actions">
          {/*
            Offered only to an admin, and only when the batch is empty — a
            batch holding client files is not something to remove in one click,
            and the route refuses it regardless.
          */}
          {canDeleteBatch && rows.length === 0 && (
            <button
              type="button"
              className="pl-btn"
              disabled={busy}
              onClick={() => deleteBatch(false)}
            >
              {t.plDeleteBatch}
            </button>
          )}
          {/* Removing a batch that still holds files. ADMIN ONLY, and guarded
              by typing the batch code rather than a dialog — see deleteBatch.
              Was gated on the temporary rehearsal flag; it is a standing admin
              power now, because an admin clearing a bad import should not need
              a code change to do it. */}
          {canDeleteBatch && rows.length > 0 && (
            <button
              type="button"
              className="pl-btn"
              style={{ color: 'var(--danger)' }}
              disabled={busy}
              onClick={() => deleteBatch(true)}
            >
              {t.plDeleteBatchForce}
            </button>
          )}
          {canEditFiles && (
            <button type="button" className="pl-btn" onClick={() => setShowBulk(true)}>
              {t.plBulkTitle}
            </button>
          )}
        </div>
      </div>

      {/*
        v2's action bar: the one action that starts work on the left, and the
        sentence that explains the numbering on the right. That sentence is not
        decoration — the file number is derived from QID order, so somebody
        looking at "001" needs to know why it is 001 and what would change it.
      */}
      <div className="pl-bar">
        {canEditFiles ? (
          <a className="pl-btn p" href={`/collections/customer/new?batch=${batch.id}`}>
            + {t.plNewCustomer}
          </a>
        ) : (
          <span />
        )}
        <span className="pl-hint">{t.plSortNote}</span>
      </div>

      <div className="files-filterbar">
        <input
          className="dash-input files-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.plSearchPlaceholder}
          aria-label={t.plSearch}
        />
        {/* Offered only when this person actually has files here. */}
        {mineCount > 0 && (
          <button
            type="button"
            className={mineOnly ? 'pl-btn p' : 'pl-btn'}
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
          >
            {t.plMyFiles} <span dir="ltr">({mineCount})</span>
          </button>
        )}
      </div>

      {/*
        The failure message goes WITH the control that caused it — beside the
        Apply button when a bulk assignment fails, and up here only when the
        thing that failed lives up here (deleting the batch). At the top of the
        page it was a screen away from a bar the person was looking at.
      */}
      {error && !selected.size && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {/* The notice-day assignment bar. Appears only with a selection. */}
      {canLead && selected.size > 0 && (
        <div className="dash-card" style={{ marginBottom: '1rem' }}>
          <div className="dash-eyebrow">
            {t.plSelected.replace('{n}', String(selected.size))}
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="pl-bulk-notice">{t.plNoticeDate}</label>
              <input
                id="pl-bulk-notice"
                type="date"
                value={noticeDate}
                onChange={(e) => setNoticeDate(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="field">
              <label htmlFor="pl-bulk-case">{t.plCaseRegDate}</label>
              <input
                id="pl-bulk-case"
                type="date"
                value={caseRegDate}
                onChange={(e) => setCaseRegDate(e.target.value)}
                dir="ltr"
              />
            </div>
          </div>
          {/*
            ¶22 — "Divide the batches among the Pay Later employees according to
            their Team Leader". Same bar as the notice dates because it is the
            same act of dividing the batch, applied to the same selection.
          */}
          <div className="field">
            <label htmlFor="pl-bulk-assignee">{t.plAssignTo}</label>
            <select
              id="pl-bulk-assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">{t.plLeaveUnchanged}</option>
              <option value="__none__">{t.plUnassign}</option>
              {assignable.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div className="dash-actions">
            <button
              type="button"
              className="pl-btn"
              onClick={() => setSelected(new Set())}
            >
              {t.plClear}
            </button>
            <button
              type="button"
              className="pl-btn p"
              disabled={busy || (!noticeDate && !caseRegDate && assignee === '')}
              onClick={applyDates}
            >
              {busy ? t.plSaving : t.plApply}
            </button>
            {error && (
              <div className="form-error" role="alert" style={{ margin: 0, flexBasis: '100%' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="dash-state-card">{t.plNoFiles}</div>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                {canLead && (
                  <th>
                    <input
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={toggleAll}
                      aria-label={t.plSelectAll}
                    />
                  </th>
                )}
                <SortableTh label={t.plFileNo} k="fileNo" sort={sort} onSort={toggleSort} />
                {/*
                  v2'S COLUMNS, IN v2'S ORDER, AND NO OTHERS.
                  File · Name · QID · Nationality · Orders · Total · Notice ·
                  Registration · Status · (actions). One name column, following
                  the language, not two. The claim, stage, bucket and assignee
                  columns are gone: the first duplicates the total, and the
                  other three belong to the case journey, which is not what this
                  table is for. All four are still on the file itself, and the
                  assignee is still set from the bar above.
                */}
                <th>{t.plName}</th>
                <SortableTh label={t.plQid} k="qid" sort={sort} onSort={toggleSort} />
                <th>{t.plNationality}</th>
                <SortableTh label={t.plOrders} k="orderCount" sort={sort} onSort={toggleSort} />
                <SortableTh label={t.plTotalDue} k="debtTotal" sort={sort} onSort={toggleSort} />
                <th>{t.plNoticeDate}</th>
                <th>{t.plCaseRegDate}</th>
                <th>{t.plStatus}</th>
                <th aria-label={t.plEditFile} />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  {canLead && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        aria-label={r.nameEn ?? r.qid ?? ''}
                      />
                    </td>
                  )}
                  <td dir="ltr">
                    {r.fileNo}
                    {r.fileNoManual && (
                      <span className="dash-chip"> {t.plManual}</span>
                    )}
                  </td>
                  {/* One name column, in the language being read — v2. */}
                  <td dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                    {/* Still an anchor, so the file keeps a real address to
                        copy or open in a new tab; the click is intercepted and
                        opens the drawer instead of navigating. */}
                    <a
                      href={`/collections/customer/${r.id}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        setOpenCustomerId(r.id);
                      }}
                    >
                      {(lang === 'ar' ? r.nameAr : r.nameEn) ?? r.nameEn ?? r.nameAr ?? ''}
                    </a>
                  </td>
                  <td dir="ltr">{r.qid ?? ''}</td>
                  <td>
                    {nationalityLabel(r.nationality, lang)}
                    {documentCount(r.nationality) !== null && (
                      <span className="pl-tag bi" dir="ltr">
                        {' '}{documentCount(r.nationality)}
                      </span>
                    )}
                  </td>
                  <td dir="ltr">{r.orderCount}</td>
                  <td dir="ltr" style={{ whiteSpace: 'nowrap' }}>{money(r.debtTotal, lang, r.currency)}</td>
                  <td dir="ltr">{r.noticePlanned ?? ''}</td>
                  <td dir="ltr">{r.caseRegDate ?? ''}</td>
                  {/*
                    v2's status tag — Complete / Needs orders / Needs data —
                    with the parts that are missing on hover, so the column is
                    the prototype's without losing what a person needs in order
                    to act on it.
                  */}
                  <td>
                    {(() => {
                      const missing = missingIntakeParts(r);
                      const names = missing
                        .map((m) => MISSING_LABEL[m](t))
                        .join(lang === 'ar' ? '، ' : ', ');
                      if (missing.length === 0) {
                        return <span className="pl-tag done">{t.plStatusDone}</span>;
                      }
                      return (
                        <span
                          className="pl-tag miss"
                          title={`${t.plIntakeMissing}: ${names}`}
                        >
                          {r.orderCount === 0 ? t.plStatusNeedsOrders : t.plStatusNeedsData}
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    <a
                      className="pl-lnk q"
                      href={`/collections/customer/${r.id}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        setOpenCustomerId(r.id);
                      }}
                    >
                      {t.plEditFile}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openCustomerId && (
        <CustomerDrawer
          customerId={openCustomerId}
          batches={batches}
          employees={assignable.map((a) => ({ userId: a.userId, name: a.name }))}
          canEditFiles={canEditFiles}
          canDeleteFiles={canDeleteFiles}
          onClose={() => setOpenCustomerId(null)}
          onSaved={() => router.refresh()}
        />
      )}

      <Toast message={toast} onDone={() => setToast(null)} />

      {showBulk && (
        <BulkReportsModal
          batches={batches}
          defaultBatchId={batch.id}
          onClose={() => setShowBulk(false)}
          onDone={() => { setShowBulk(false); router.refresh(); }}
        />
      )}
    </div>
  );
}

/**
 * A sortable column header. Rendered as a button inside the th so it is
 * reachable by keyboard, and carries aria-sort so a screen reader announces the
 * direction rather than just reading an arrow glyph.
 */
function SortableTh({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort: (k: SortKey) => void;
}) {
  const active = sort?.key === k;
  return (
    <th aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(k)}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span>{label}</span>
        {/* The arrow is decorative — aria-sort above carries the meaning. */}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.28 }}>
          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}
