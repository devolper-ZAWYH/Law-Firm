'use client';

/**
 * الملاحظات — problems found in the source files, flagged and not fixed.
 *
 * This screen is the spec's answer to a specific failure: D100 #31 is a GUESS
 * sitting underneath figures that reconcile. Two rows were numbered 1, #31 was
 * missing, and the parser assigned the larger claim to #31 so the totals would
 * balance. Nobody has confirmed it. A number that balances a report is exactly
 * the kind of number people stop questioning, so it is shown here as unresolved
 * until somebody actually says yes.
 *
 * Nothing on this screen was corrected during import. Each entry says what the
 * problem is and what the import did about it, separately, so the reader can
 * disagree with the second without losing the first.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePaylaterLang } from './PaylaterShell';

export interface NoteIssue {
  id: string;
  kind: string;
  severity: string;
  detail: string;
  resolution: string | null;
  confirmedAt: string | null;
  batchCode: string | null;
}

export default function NotesView({
  issues,
  canConfirm,
}: {
  issues: NoteIssue[];
  canConfirm: boolean;
}) {
  // One language for the whole portal, owned by the shell.
  const { lang, t, dir } = usePaylaterLang();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [qidPreview, setQidPreview] = useState<{
    affected: number;
    sample: { from: string; to: string }[];
  } | null>(null);
  const [qidDone, setQidDone] = useState<number | null>(null);
  const [qidError, setQidError] = useState<string | null>(null);

  /**
   * The QID correction is shown as PREVIEW → CONFIRM, never one click.
   * It rewrites a client identifier that gets printed on a legal notice, so the
   * person triggering it should see exactly what changes before it happens.
   */
  async function qidCorrection(mode: 'preview' | 'commit') {
    setBusy('qid');
    setQidError(null);
    try {
      const res = await fetch('/api/paylater/qid-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        preview?: { affected: number; sample: { from: string; to: string }[] };
        corrected?: number;
        error?: string;
      };
      // A failure used to return silently here, so a 500 looked exactly like a
      // button that did nothing. Say what happened.
      if (!res.ok || !data.ok) {
        setQidError(data.error ?? 'Could not apply the correction.');
        return;
      }
      if (mode === 'preview') setQidPreview(data.preview ?? null);
      else {
        setQidDone(data.corrected ?? 0);
        setQidPreview(null);
        router.refresh();
      }
    } catch {
      setQidError('Network error.');
    } finally {
      setBusy(null);
    }
  }

  async function confirm(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/paylater/issues/${id}/confirm`, { method: 'POST' });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity !== 'error');

  return (
    <div dir={dir}>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.plIssues}</h1>
          <p className="dash-subtitle">{t.plIssuesSubtitle}</p>
        </div>
      </div>

      {issues.length === 0 ? (
        <div className="dash-state-card">{t.plNoIssues}</div>
      ) : (
        <>
          {[
            { list: errors, label: t.plSeverityError, gold: true },
            { list: warns, label: t.plSeverityWarn, gold: false },
          ].map(({ list, label, gold }) =>
            list.length === 0 ? null : (
              <section key={label}>
                <h2 className="dash-title-sm">
                  {label} <span dir="ltr">({list.length})</span>
                </h2>
                <div className="pl-notes-grid">
                {list.map((i) => (
                  <div
                    className={`dash-card pl-note-card${
                      qidPreview && i.kind === 'qid_trailing_zero' ? ' is-expanded' : ''
                    }`}
                    key={i.id}
                  >
                    <div className="dash-section-header pl-note-head">
                      <div>
                        <span className={`dash-chip${gold ? ' dash-chip-gold' : ''}`}>
                          {i.kind}
                        </span>
                        {i.batchCode && (
                          <span className="dash-chip" dir="ltr">
                            {i.batchCode}
                          </span>
                        )}
                        {i.confirmedAt && (
                          <span className="dash-pill dash-pill-green">
                            {t.plConfirmed}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="pl-note-body">
                      <p>{i.detail}</p>

                      {i.resolution && (
                        <p className="dash-hint">
                          <strong>{t.plIssueResolution}:</strong> {i.resolution}
                        </p>
                      )}
                    </div>

                    <div className="pl-note-actions">

                    {/*
                      Only offered where a human answer actually changes
                      something — an unconfirmed guess. There is nothing to
                      confirm about a QID that is simply two digits long.
                    */}
                    {/*
                      The trailing-zero QIDs are the one flagged issue that can
                      actually be REPAIRED rather than merely confirmed, so it
                      gets a repair control instead of a "confirm" one.
                    */}
                    {canConfirm && !i.confirmedAt && i.kind === 'qid_trailing_zero' && (
                      <div>
                        {!qidPreview ? (
                          <button
                            type="button"
                            className="pl-btn"
                            disabled={busy === 'qid'}
                            onClick={() => qidCorrection('preview')}
                          >
                            {lang === 'ar'
                              ? 'معاينة التصحيح'
                              : 'Preview the correction'}
                          </button>
                        ) : (
                          <>
                            <p className="dash-hint">
                              {lang === 'ar'
                                ? `سيتم تصحيح ${qidPreview.affected} رقمًا شخصيًا. تُحفظ القيمة الأصلية في سجل كل ملف.`
                                : `${qidPreview.affected} QIDs will be corrected. The original value is kept in each file's history.`}
                            </p>
                            <div className="dash-table-wrap">
                              <table className="dash-table">
                                <thead>
                                  <tr>
                                    <th>{lang === 'ar' ? 'الحالي' : 'Now'}</th>
                                    <th>{lang === 'ar' ? 'بعد التصحيح' : 'After'}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {qidPreview.sample.map((x) => (
                                    <tr key={x.from}>
                                      <td dir="ltr">{x.from}</td>
                                      <td dir="ltr">{x.to}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="dash-actions">
                              <button
                                type="button"
                                className="pl-btn"
                                onClick={() => setQidPreview(null)}
                              >
                                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                              </button>
                              <button
                                type="button"
                                className="pl-btn p"
                                disabled={busy === 'qid'}
                                onClick={() => qidCorrection('commit')}
                              >
                                {busy === 'qid'
                                  ? t.plSaving
                                  : lang === 'ar'
                                    ? 'تطبيق التصحيح'
                                    : 'Apply the correction'}
                              </button>
                            </div>
                          </>
                        )}
                        {qidError && (
                          <div className="form-error" role="alert">
                            {qidError}
                          </div>
                        )}
                        {qidDone !== null && (
                          <div className="form-success" role="status">
                            {lang === 'ar'
                              ? `تم تصحيح ${qidDone} رقمًا شخصيًا.`
                              : `${qidDone} QIDs corrected.`}
                          </div>
                        )}
                      </div>
                    )}

                    {canConfirm &&
                      !i.confirmedAt &&
                      i.kind === 'duplicate_row_number' && (
                        <button
                          type="button"
                          className="pl-btn"
                          disabled={busy === i.id}
                          onClick={() => confirm(i.id)}
                        >
                          {busy === i.id ? t.plSaving : t.plConfirmIssue}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                </div>
              </section>
            )
          )}
        </>
      )}
    </div>
  );
}
