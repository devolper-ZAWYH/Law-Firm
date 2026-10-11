'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatDate, formatMinutesDuration, formatMonthLong } from '@/lib/format';
import LeaveCard from './LeaveCard';
import TimeOfDayPicker from './TimeOfDayPicker';

/**
 * Attendance screen — upload the ZKTeco "Total Time Card" Excel export and
 * see a per-employee late/early-out summary for the current 25th→24th
 * period. Upload is shown to whoever has can_upload_attendance (admin,
 * manager, or the one designated employee); the company-wide summary table
 * is admin/manager ONLY — an employee (even the uploader) never sees anyone
 * else's attendance, only their own (AttendanceBanner, elsewhere).
 */

interface UploadResult {
  totalRows: number;
  matchedRows: number;
  unmatchedZktecoIds: string[];
  dateRange: { start: string; end: string } | null;
  objectionsCreated?: number;
}

/** One archived attendance file, as listed in the "Uploaded files" section. */
interface UploadedFile {
  id: string;
  fileName: string;
  uploadedByNameEn: string | null;
  uploadedByNameAr: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  totalRows: number;
  matchedRows: number;
  recordCount: number;
  createdAt: string;
}

/** An objection awaiting this manager's decision. */
interface PendingObjection {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
  date: string;
  comment: string;
  requestedMinutes: number;
  raisedByNameEn: string | null;
  raisedByNameAr: string | null;
  dayLateMinutes: number;
  dayEarlyOutMinutes: number;
}

type DayStatus = 'present' | 'absent' | 'vacation';

interface SheetRow {
  employeeId: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  lateMinutes: number;
  earlyOutMinutes: number;
  nameEn: string | null;
  nameAr: string | null;
  matched: boolean;
  /** Marked by the uploader here — the device cannot tell "did not come in"
   * from "no record". Absent counts as a full working day late; vacation as 0. */
  dayStatus?: DayStatus;
  /**
   * A removal STAGED on this row, not yet sent anywhere. Objections travel
   * with the commit so they always land on a day that was actually saved, at
   * the date the uploader confirmed — see the upload route.
   */
  objection?: { minutes: number; comment: string };
}

/** '90' -> '1h 30m', '45' -> '45m'. Small enough not to justify a helper import. */
function hoursAndMinutes(total: number, ar: boolean): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return ar ? `${m} د` : `${m}m`;
  if (m === 0) return ar ? `${h} س` : `${h}h`;
  return ar ? `${h} س ${m} د` : `${h}h ${m}m`;
}

/** 'HH:MM:SS' or 'HH:MM' -> 'HH:MM' for TimeOfDayPicker; null -> ''. */
function toTimeInputValue(v: string | null): string {
  return v ? v.slice(0, 5) : '';
}

/** Whole-day difference between two 'YYYY-MM-DD' dates (b - a). */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000
  );
}

function shiftIsoDate(date: string, offsetDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

interface SummaryRow {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  totalLateMinutes: number;
  totalEarlyOutMinutes: number;
}

export default function AttendanceView() {
  const { lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';
  const isAdmin = activeCompany?.role === 'admin';
  const isManager = activeCompany?.role === 'manager' || activeCompany?.isManager === true;

  const [canUpload, setCanUpload] = useState(false);
  const [canViewAllGrant, setCanViewAllGrant] = useState(false);
  // 'attendance.leave' has no legacy boolean — it only lives in the capability
  // tree, so it is read from `capabilities` rather than `permissions`.
  const [canSetLeaveGrant, setCanSetLeaveGrant] = useState(false);
  // 'attendance.objection' likewise lives only in the capability tree.
  const [canObjectGrant, setCanObjectGrant] = useState(false);
  const [permsLoading, setPermsLoading] = useState(true);

  useEffect(() => {
    if (!companyId) {
      setPermsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setPermsLoading(true);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/permissions/me`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          permissions?: { canUploadAttendance?: boolean };
          capabilities?: string[];
        };
        if (!cancelled && res.ok && data.ok) {
          setCanUpload(data.permissions?.canUploadAttendance === true);
          setCanViewAllGrant(
            Array.isArray(data.capabilities) &&
              data.capabilities.includes('attendance.viewAll')
          );
          setCanSetLeaveGrant(
            Array.isArray(data.capabilities) &&
              data.capabilities.includes('attendance.leave')
          );
          setCanObjectGrant(
            Array.isArray(data.capabilities) &&
              data.capabilities.includes('attendance.objection')
          );
        }
      } finally {
        if (!cancelled) setPermsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Without 'attendance.viewAll' (or the admin/manager baseline) a person
  // only ever sees their own attendance — see GET /api/attendance/me.
  const canSeeSummary = isAdmin || isManager || canViewAllGrant;

  // Booking leave is its own grant — an employee may hold it without being able
  // to upload the sheet or see anyone else's attendance.
  const canSetLeave = isAdmin || isManager || canSetLeaveGrant;

  // Raising an objection from the review table. The button also needs the
  // company to HAVE a designated approver — loaded below — since there is
  // nobody to send it to otherwise.
  const canObject = isAdmin || isManager || canObjectGrant;

  // Two-phase upload: (1) parse the file and let the uploader confirm/fix the
  // detected date before anything is stored, (2) commit — warning first if
  // any of the (possibly corrected) dates would overwrite existing data.
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [editableRows, setEditableRows] = useState<SheetRow[] | null>(null);
  const [detectedRange, setDetectedRange] = useState<{ start: string; end: string } | null>(
    null
  );
  const [confirmedStart, setConfirmedStart] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The workbook behind the current review, handed back by /parse and posted
   * on commit so it can be archived. Null when re-editing an existing upload
   * (that file is already stored). */
  const [pendingFile, setPendingFile] = useState<{ name: string; base64: string } | null>(
    null
  );
  /** Set when the review table was opened from the "Uploaded files" list, so
   * saving updates that upload instead of archiving a second copy. */
  const [editingUploadId, setEditingUploadId] = useState<string | null>(null);

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [conflictDates, setConflictDates] = useState<string[] | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  function resetUploadFlow() {
    setEditableRows(null);
    setDetectedRange(null);
    setConfirmedStart('');
    setConflictDates(null);
    setCommitError(null);
    setPendingFile(null);
    setEditingUploadId(null);
    setObjectionRowIndex(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function patchRow(index: number, patch: Partial<SheetRow>) {
    setEditableRows((prev) =>
      prev ? prev.map((r, i) => (i === index ? { ...r, ...patch } : r)) : prev
    );
  }

  async function onParse(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file || !companyId) return;
    setParsing(true);
    setParseError(null);
    setUploadResult(null);
    setConflictDates(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/parse`,
        { method: 'POST', body: form }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        dateRange?: { start: string; end: string };
        rows?: SheetRow[];
        fileName?: string;
        fileBase64?: string;
      };
      if (!res.ok || !data.ok || !data.rows || !data.dateRange) {
        setParseError(data.error || (ar ? 'تعذّر قراءة الملف.' : 'Could not read the file.'));
        setParsing(false);
        return;
      }
      setEditableRows(data.rows);
      setDetectedRange(data.dateRange);
      setConfirmedStart(data.dateRange.start);
      setEditingUploadId(null);
      setPendingFile(
        data.fileName && data.fileBase64
          ? { name: data.fileName, base64: data.fileBase64 }
          : null
      );
      setParsing(false);
    } catch {
      setParseError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setParsing(false);
    }
  }

  async function commitUpload(overwrite: boolean) {
    if (!editableRows || !detectedRange || !companyId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const dateOffsetDays = daysBetween(detectedRange.start, confirmedStart);
      const rows = editableRows.map((r) => ({
        employeeId: r.employeeId,
        date: r.date,
        clockIn: r.clockIn,
        clockOut: r.clockOut,
        lateMinutes: r.lateMinutes,
        earlyOutMinutes: r.earlyOutMinutes,
        dayStatus: r.dayStatus ?? 'present',
      }));
      const objections = editableRows
        .filter((r) => r.objection && r.objection.minutes > 0)
        .map((r) => ({
          employeeId: r.employeeId,
          date: r.date,
          minutes: r.objection!.minutes,
          comment: r.objection!.comment,
        }));
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows,
            dateOffsetDays,
            // Re-saving an existing upload always rewrites its own days, so
            // the "already recorded" prompt would just be noise.
            overwrite: overwrite || editingUploadId !== null,
            objections,
            file: pendingFile,
            uploadId: editingUploadId,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        needsConfirmation?: boolean;
        conflictingDates?: string[];
        result?: UploadResult;
      };
      if (!res.ok && !data.needsConfirmation) {
        setCommitError(data.error || (ar ? 'تعذّر رفع الملف.' : 'Could not upload the file.'));
        setCommitting(false);
        return;
      }
      if (data.needsConfirmation) {
        setConflictDates(data.conflictingDates ?? []);
        setCommitting(false);
        return;
      }
      if (!data.ok || !data.result) {
        setCommitError(data.error || (ar ? 'تعذّر رفع الملف.' : 'Could not upload the file.'));
        setCommitting(false);
        return;
      }
      setUploadResult(data.result);
      setCommitting(false);
      resetUploadFlow();
      loadSummary();
      loadUploads();
      // The uploader may also BE the approver — their own objection has to
      // show up in the queue without a manual reload.
      loadPendingObjections();
    } catch {
      setCommitError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setCommitting(false);
    }
  }

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  /** Which 25th→24th cycle the totals below cover, as returned by the API. */
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!companyId || !canSeeSummary) {
      setSummaryLoading(false);
      return;
    }
    setSummaryLoading(true);
    setSummaryError(false);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/summary`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        summary?: SummaryRow[];
        period?: { start: string; end: string };
      };
      if (!res.ok || !data.ok || !Array.isArray(data.summary)) {
        setSummaryError(true);
        setSummary([]);
      } else {
        setSummary(data.summary);
        setPeriod(data.period ?? null);
      }
    } catch {
      setSummaryError(true);
    } finally {
      setSummaryLoading(false);
    }
  }, [companyId, canSeeSummary]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // ---- Objections raised from the review table ----------------------------

  /** Which row's objection card is open, or null. */
  const [objectionRowIndex, setObjectionRowIndex] = useState<number | null>(null);
  const [objHours, setObjHours] = useState('0');
  const [objMinutes, setObjMinutes] = useState('0');
  const [objComment, setObjComment] = useState('');
  const [objError, setObjError] = useState<string | null>(null);
  /** Whether the admin has designated anyone to decide objections. Without
   * one there is nowhere to send them, so the button says so instead. */
  const [hasApprover, setHasApprover] = useState<boolean | null>(null);

  useEffect(() => {
    if (!companyId || !canObject) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/settings`, {
          cache: 'no-store',
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          settings?: { attendance_objection_approver_id?: string | null };
        };
        if (!cancelled && res.ok && data.ok) {
          setHasApprover(!!data.settings?.attendance_objection_approver_id);
        }
      } catch {
        /* leave unknown — the server re-checks on commit anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, canObject]);

  function openObjectionCard(index: number) {
    const existing = editableRows?.[index]?.objection;
    setObjectionRowIndex(index);
    setObjHours(existing ? String(Math.floor(existing.minutes / 60)) : '0');
    setObjMinutes(existing ? String(existing.minutes % 60) : '0');
    setObjComment(existing?.comment ?? '');
    setObjError(null);
  }

  function submitObjectionCard() {
    if (objectionRowIndex === null) return;
    const h = Math.max(0, parseInt(objHours, 10) || 0);
    const m = Math.max(0, parseInt(objMinutes, 10) || 0);
    const total = h * 60 + m;
    if (total <= 0) {
      setObjError(ar ? 'أدخل وقتًا أكبر من صفر.' : 'Enter an amount greater than zero.');
      return;
    }
    if (total > 24 * 60) {
      setObjError(ar ? 'الوقت المطلوب كبير جدًا.' : 'That is more than a whole day.');
      return;
    }
    if (!objComment.trim()) {
      setObjError(ar ? 'السبب مطلوب.' : 'A reason is required.');
      return;
    }
    patchRow(objectionRowIndex, {
      objection: { minutes: total, comment: objComment.trim() },
    });
    setObjectionRowIndex(null);
  }

  // ---- Pending objections (the designated approver's queue) ---------------

  const [pendingObjections, setPendingObjections] = useState<PendingObjection[]>([]);
  const [isApprover, setIsApprover] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadPendingObjections = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/objections`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        isApprover?: boolean;
        objections?: PendingObjection[];
      };
      if (res.ok && data.ok) {
        setIsApprover(data.isApprover === true);
        setPendingObjections(Array.isArray(data.objections) ? data.objections : []);
      }
    } catch {
      /* the card simply stays empty */
    }
  }, [companyId]);

  useEffect(() => {
    loadPendingObjections();
  }, [loadPendingObjections]);

  async function decide(objectionId: string, approve: boolean) {
    if (!companyId) return;
    setDecidingId(objectionId);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/objections/${encodeURIComponent(objectionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve }),
        }
      );
      if (res.ok) {
        await Promise.all([loadPendingObjections(), loadSummary()]);
      }
    } finally {
      setDecidingId(null);
    }
  }

  // ---- Uploaded files ----------------------------------------------------

  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [busyUploadId, setBusyUploadId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadUploads = useCallback(async () => {
    if (!companyId || !canUpload) return;
    setUploadsLoading(true);
    setUploadsError(null);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/uploads`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        uploads?: UploadedFile[];
      };
      if (!res.ok || !data.ok) {
        setUploadsError(ar ? 'تعذّر تحميل الملفات.' : 'Could not load the files.');
      } else {
        setUploads(Array.isArray(data.uploads) ? data.uploads : []);
      }
    } catch {
      setUploadsError(ar ? 'خطأ في الشبكة.' : 'Network error.');
    } finally {
      setUploadsLoading(false);
    }
  }, [companyId, canUpload, ar]);

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  /** Re-open a past upload in the SAME review table used after a fresh parse. */
  async function editUpload(uploadId: string) {
    if (!companyId) return;
    setBusyUploadId(uploadId);
    setCommitError(null);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/uploads/${encodeURIComponent(uploadId)}`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        rows?: SheetRow[];
        dateRange?: { start: string; end: string } | null;
      };
      if (!res.ok || !data.ok || !data.rows || data.rows.length === 0 || !data.dateRange) {
        setUploadsError(
          ar ? 'لا توجد أيام محفوظة من هذا الملف.' : 'This file has no saved days to edit.'
        );
        return;
      }
      setUploadResult(null);
      setConflictDates(null);
      setPendingFile(null);
      setEditableRows(data.rows);
      setDetectedRange(data.dateRange);
      setConfirmedStart(data.dateRange.start);
      setEditingUploadId(uploadId);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setUploadsError(ar ? 'خطأ في الشبكة.' : 'Network error.');
    } finally {
      setBusyUploadId(null);
    }
  }

  async function deleteUpload(uploadId: string) {
    if (!companyId) return;
    setBusyUploadId(uploadId);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/attendance/uploads/${encodeURIComponent(uploadId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        setUploadsError(ar ? 'تعذّر الحذف.' : 'Could not delete the file.');
        return;
      }
      setConfirmDeleteId(null);
      if (editingUploadId === uploadId) resetUploadFlow();
      await Promise.all([loadUploads(), loadSummary()]);
    } catch {
      setUploadsError(ar ? 'خطأ في الشبكة.' : 'Network error.');
    } finally {
      setBusyUploadId(null);
    }
  }

  if (!activeCompany) {
    return (
      <>
        <h1 className="dash-title">{ar ? 'الحضور' : 'Attendance'}</h1>
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {ar ? 'اختر شركة أولاً.' : 'Select a company first.'}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="dash-title">{ar ? 'الحضور' : 'Attendance'}</h1>
      <p className="dash-subtitle" style={{ marginBlockEnd: 16 }}>
        {ar
          ? 'رفع كشف الحضور من جهاز ZKTeco وعرض ملخص التأخير لكل موظف.'
          : "Upload the ZKTeco attendance sheet and see each employee's lateness summary."}
      </p>

      {isApprover && pendingObjections.length > 0 && (
        <div className="dash-card" style={{ marginBottom: 16 }}>
          <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
            {ar ? 'اعتراضات بانتظار قرارك' : 'Attendance objections awaiting you'}
          </div>
          <p className="dash-subtitle" style={{ margin: '0 0 10px' }}>
            {ar
              ? 'الموافقة تخصم الوقت المطلوب من ذلك اليوم، والرفض يُبقي الدقائق كما هي.'
              : 'Approving removes the requested time from that day; rejecting keeps the minutes as recorded.'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pendingObjections.map((o) => {
              const who = (ar ? o.nameAr : o.nameEn) || o.nameEn || o.nameAr || '—';
              const by =
                (ar ? o.raisedByNameAr : o.raisedByNameEn) ||
                o.raisedByNameEn ||
                o.raisedByNameAr;
              return (
                <div
                  key={o.id}
                  style={{
                    border: '1px solid var(--border, #E9E7E0)',
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {who} — <span dir="ltr">{o.date}</span>
                  </div>
                  <p className="dash-hint" style={{ margin: '4px 0 0' }}>
                    {ar
                      ? `مسجّل حاليًا: تأخير ${formatMinutesDuration(o.dayLateMinutes, lang)}، مغادرة مبكرة ${formatMinutesDuration(o.dayEarlyOutMinutes, lang)}.`
                      : `Currently recorded: ${formatMinutesDuration(o.dayLateMinutes, lang)} late, ${formatMinutesDuration(o.dayEarlyOutMinutes, lang)} early out.`}
                  </p>
                  <p style={{ margin: '6px 0 0', fontSize: 13.5 }}>
                    {ar ? 'المطلوب خصمه: ' : 'Requested removal: '}
                    <strong>{hoursAndMinutes(o.requestedMinutes, ar)}</strong>
                    {by && (ar ? ` — بطلب من ${by}` : ` — raised by ${by}`)}
                  </p>
                  <p style={{ margin: '6px 0 0', fontSize: 13.5 }} dir="auto">
                    {ar ? 'السبب: ' : 'Reason: '}
                    {o.comment}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="dash-btn-gold"
                      disabled={decidingId === o.id}
                      onClick={() => decide(o.id, true)}
                    >
                      {ar ? 'موافقة' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="dash-btn-ghost"
                      disabled={decidingId === o.id}
                      onClick={() => decide(o.id, false)}
                    >
                      {ar ? 'رفض' : 'Reject'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!permsLoading && canSetLeave && companyId && (
        <LeaveCard companyId={companyId} />
      )}

      {!permsLoading && canUpload && (
        <div className="dash-card" style={{ marginBottom: 16 }}>
          <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
            {ar ? 'رفع كشف الحضور' : 'Upload attendance sheet'}
          </div>

          {!editableRows && (
            <form onSubmit={onParse}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="dash-input"
                style={{ marginBottom: 10 }}
              />
              {parseError && (
                <div className="dash-alert dash-alert-error" role="alert">
                  {parseError}
                </div>
              )}
              {uploadResult && (
                <div className="dash-alert" style={{ marginBottom: 10 }}>
                  {ar
                    ? `تمّت المطابقة: ${uploadResult.matchedRows} من ${uploadResult.totalRows} صفًا.`
                    : `Matched ${uploadResult.matchedRows} of ${uploadResult.totalRows} rows.`}
                  {uploadResult.dateRange && (
                    <div style={{ marginTop: 6 }} dir="ltr">
                      {ar ? 'الفترة المرفوعة: ' : 'Uploaded date range: '}
                      {uploadResult.dateRange.start === uploadResult.dateRange.end
                        ? uploadResult.dateRange.start
                        : `${uploadResult.dateRange.start} → ${uploadResult.dateRange.end}`}
                    </div>
                  )}
                  {uploadResult.unmatchedZktecoIds.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {ar ? 'معرّفات غير مطابقة: ' : 'Unmatched IDs: '}
                      {uploadResult.unmatchedZktecoIds.join(', ')}
                    </div>
                  )}
                </div>
              )}
              <button type="submit" className="dash-btn-gold" disabled={parsing}>
                {parsing ? (ar ? 'جارٍ القراءة…' : 'Reading…') : ar ? 'رفع' : 'Upload'}
              </button>
            </form>
          )}

          {editableRows && detectedRange && conflictDates === null && (
            <div>
              <p className="dash-subtitle" style={{ margin: '0 0 10px' }}>
                {editingUploadId
                  ? ar
                    ? 'تعديل ملف مرفوع سابقًا — سيحلّ الحفظ محلّ الأيام المسجّلة منه.'
                    : 'Editing a previously uploaded file — saving replaces the days it recorded.'
                  : ar
                  ? 'يرجى تأكيد تاريخ هذا الكشف قبل الحفظ.'
                  : 'Please confirm the date for this sheet before saving.'}
              </p>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="attendance-confirm-date">
                  {detectedRange.start === detectedRange.end
                    ? ar
                      ? 'التاريخ المكتشف'
                      : 'Detected date'
                    : ar
                    ? 'تاريخ بداية الفترة المكتشفة'
                    : 'Detected period start date'}
                </label>
                <input
                  id="attendance-confirm-date"
                  type="date"
                  className="dash-input"
                  value={confirmedStart}
                  dir="ltr"
                  onChange={(e) => setConfirmedStart(e.target.value)}
                />
              </div>
              {detectedRange.start !== detectedRange.end && confirmedStart && (
                <p className="dash-hint" style={{ margin: '4px 0 0' }} dir="ltr">
                  {ar ? 'الفترة النهائية: ' : 'Resulting range: '}
                  {confirmedStart} →{' '}
                  {shiftIsoDate(
                    detectedRange.end,
                    daysBetween(detectedRange.start, confirmedStart)
                  )}
                </p>
              )}

              <p className="dash-subtitle" style={{ margin: '16px 0 8px' }}>
                {ar
                  ? 'يرجى مراجعة بيانات كل موظف، ويمكن التعديل إن كان هناك خطأ.'
                  : "Please review each employee's data below — edit anything that's wrong."}
              </p>
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>{ar ? 'الاسم' : 'Name'}</th>
                      {detectedRange.start !== detectedRange.end && (
                        <th>{ar ? 'التاريخ' : 'Date'}</th>
                      )}
                      <th>{ar ? 'وقت الحضور' : 'Time in'}</th>
                      <th>{ar ? 'وقت الانصراف' : 'Time out'}</th>
                      <th>{ar ? 'دقائق التأخير' : 'Late (min)'}</th>
                      <th>{ar ? 'دقائق المغادرة المبكرة' : 'Early out (min)'}</th>
                      <th>{ar ? 'الحالة' : 'Day'}</th>
                      {canObject && <th>{ar ? 'اعتراض' : 'Objection'}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {editableRows.map((r, i) => {
                      const offsetDays = daysBetween(detectedRange.start, confirmedStart || detectedRange.start);
                      const shownDate = shiftIsoDate(r.date, offsetDays);
                      const displayName =
                        (ar ? r.nameAr : r.nameEn) || r.nameEn || r.nameAr;
                      return (
                        <tr key={`${r.employeeId}-${r.date}-${i}`}>
                          <td>
                            {displayName ?? (
                              <span style={{ color: '#9a3b2f' }}>
                                {ar
                                  ? `غير مطابق (رقم ${r.employeeId})`
                                  : `Unmatched (ID ${r.employeeId})`}
                              </span>
                            )}
                          </td>
                          {detectedRange.start !== detectedRange.end && (
                            <td className="dash-td-muted" dir="ltr">
                              {shownDate}
                            </td>
                          )}
                          <td>
                            {/* 12-hour, and immune to the RTL segment
                                reversal a native time input suffers — see
                                components/TimeOfDayPicker.tsx. Still 'HH:MM'
                                on both sides, so the row keeps its seconds. */}
                            <TimeOfDayPicker
                              value={toTimeInputValue(r.clockIn) || null}
                              ar={ar}
                              disabled={false}
                              onChange={(v) =>
                                patchRow(i, { clockIn: v ? `${v}:00` : null })
                              }
                            />
                          </td>
                          <td>
                            <TimeOfDayPicker
                              value={toTimeInputValue(r.clockOut) || null}
                              ar={ar}
                              disabled={false}
                              onChange={(v) =>
                                patchRow(i, { clockOut: v ? `${v}:00` : null })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              className="dash-input"
                              dir="ltr"
                              style={{ minInlineSize: 70 }}
                              value={r.lateMinutes}
                              onChange={(e) =>
                                patchRow(i, { lateMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              className="dash-input"
                              dir="ltr"
                              style={{ minInlineSize: 70 }}
                              value={r.earlyOutMinutes}
                              onChange={(e) =>
                                patchRow(i, {
                                  earlyOutMinutes: Math.max(0, parseInt(e.target.value, 10) || 0),
                                })
                              }
                            />
                          </td>
                          {/* Absent / Vacation. The device cannot tell "did not
                              come in" from "no record", so the uploader marks
                              it. Absent scores a full working day late (8h);
                              vacation scores zero. Clicking the active choice
                              again clears it back to a normal day. */}
                          <td>
                            <span style={{ display: 'inline-flex', gap: 6, whiteSpace: 'nowrap' }}>
                              {(
                                [
                                  { key: 'absent' as const, en: 'Absent', arLabel: 'غائب', color: '#C24A3C' },
                                  { key: 'vacation' as const, en: 'Vacation', arLabel: 'إجازة', color: '#5E8C70' },
                                ]
                              ).map((opt) => {
                                const on = (r.dayStatus ?? 'present') === opt.key;
                                return (
                                  <button
                                    key={opt.key}
                                    type="button"
                                    className="dash-btn-ghost"
                                    aria-pressed={on}
                                    style={{
                                      padding: '3px 9px',
                                      fontSize: 12.5,
                                      borderColor: opt.color,
                                      color: on ? '#fff' : opt.color,
                                      background: on ? opt.color : 'transparent',
                                    }}
                                    onClick={() =>
                                      patchRow(i, { dayStatus: on ? 'present' : opt.key })
                                    }
                                  >
                                    {ar ? opt.arLabel : opt.en}
                                  </button>
                                );
                              })}
                            </span>
                          </td>
                          {/* Ask the designated manager to take time off this
                              day. Staged here and sent with the commit — see
                              SheetRow.objection. */}
                          {canObject && (
                            <td>
                              {r.objection ? (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="dash-btn-ghost"
                                    style={{
                                      padding: '3px 9px',
                                      fontSize: 12.5,
                                      borderColor: 'var(--albaker-gold, #BD9446)',
                                      color: 'var(--albaker-gold, #BD9446)',
                                    }}
                                    onClick={() => openObjectionCard(i)}
                                  >
                                    −{hoursAndMinutes(r.objection.minutes, ar)}
                                  </button>
                                  <button
                                    type="button"
                                    className="dash-btn-ghost"
                                    aria-label={ar ? 'إلغاء الاعتراض' : 'Remove objection'}
                                    style={{ padding: '3px 8px', fontSize: 12.5 }}
                                    onClick={() => patchRow(i, { objection: undefined })}
                                  >
                                    ×
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="dash-btn-ghost"
                                  style={{ padding: '3px 9px', fontSize: 12.5 }}
                                  disabled={hasApprover === false}
                                  title={
                                    hasApprover === false
                                      ? ar
                                        ? 'لم يُحدَّد مدير للاعتراضات في إعدادات الشركة.'
                                        : 'No objection approver is set in Company settings.'
                                      : undefined
                                  }
                                  onClick={() => openObjectionCard(i)}
                                >
                                  {ar ? 'اعتراض' : 'Object'}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {objectionRowIndex !== null && editableRows[objectionRowIndex] && (
                <div
                  role="dialog"
                  aria-modal="true"
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 16,
                    zIndex: 60,
                  }}
                  onClick={() => setObjectionRowIndex(null)}
                >
                  <div
                    className="dash-card"
                    style={{ maxInlineSize: 420, inlineSize: '100%' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
                      {ar ? 'اعتراض على الحضور' : 'Attendance objection'}
                    </div>
                    <p className="dash-subtitle" style={{ margin: '0 0 12px' }}>
                      {(ar
                        ? editableRows[objectionRowIndex].nameAr
                        : editableRows[objectionRowIndex].nameEn) ||
                        editableRows[objectionRowIndex].nameEn ||
                        editableRows[objectionRowIndex].nameAr ||
                        editableRows[objectionRowIndex].employeeId}{' '}
                      —{' '}
                      <span dir="ltr">
                        {shiftIsoDate(
                          editableRows[objectionRowIndex].date,
                          daysBetween(detectedRange.start, confirmedStart || detectedRange.start)
                        )}
                      </span>
                    </p>
                    <p className="dash-hint" style={{ margin: '0 0 12px' }}>
                      {ar
                        ? 'الوقت المطلوب حذفه من حضور هذا اليوم — لا يُحتسب تأخيرًا ولا مغادرة مبكرة بعد الموافقة.'
                        : "Time to remove from this day's attendance — once approved it stops counting as late or early out."}
                    </p>
                    {objError && (
                      <div className="dash-alert dash-alert-error" role="alert">
                        {objError}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div className="dash-field" style={{ flex: 1 }}>
                        <label className="dash-eyebrow" htmlFor="objection-hours">
                          {ar ? 'ساعات' : 'Hours'}
                        </label>
                        <input
                          id="objection-hours"
                          type="number"
                          min={0}
                          max={24}
                          dir="ltr"
                          className="dash-input"
                          value={objHours}
                          onChange={(e) => setObjHours(e.target.value)}
                        />
                      </div>
                      <div className="dash-field" style={{ flex: 1 }}>
                        <label className="dash-eyebrow" htmlFor="objection-minutes">
                          {ar ? 'دقائق' : 'Minutes'}
                        </label>
                        <input
                          id="objection-minutes"
                          type="number"
                          min={0}
                          max={59}
                          dir="ltr"
                          className="dash-input"
                          value={objMinutes}
                          onChange={(e) => setObjMinutes(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="dash-field">
                      <label className="dash-eyebrow" htmlFor="objection-reason">
                        {ar ? 'السبب' : 'Reason'}
                      </label>
                      <textarea
                        id="objection-reason"
                        className="dash-input"
                        rows={2}
                        value={objComment}
                        onChange={(e) => setObjComment(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button
                        type="button"
                        className="dash-btn-ghost"
                        onClick={() => setObjectionRowIndex(null)}
                      >
                        {ar ? 'إلغاء' : 'Cancel'}
                      </button>
                      <button type="button" className="dash-btn-gold" onClick={submitObjectionCard}>
                        {ar ? 'إرسال' : 'Send'}
                      </button>
                    </div>
                    <p className="dash-hint" style={{ margin: '10px 0 0' }}>
                      {ar
                        ? 'يُرسَل إلى المدير المعيَّن عند حفظ الكشف.'
                        : 'Sent to the designated manager when the sheet is saved.'}
                    </p>
                  </div>
                </div>
              )}

              {commitError && (
                <div className="dash-alert dash-alert-error" role="alert" style={{ marginTop: 10 }}>
                  {commitError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="dash-btn-ghost"
                  onClick={resetUploadFlow}
                  disabled={committing}
                >
                  {ar ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  type="button"
                  className="dash-btn-gold"
                  disabled={committing || !confirmedStart}
                  onClick={() => commitUpload(false)}
                >
                  {committing ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'تأكيد وحفظ' : 'Confirm & save'}
                </button>
              </div>
            </div>
          )}

          {editableRows && conflictDates !== null && (
            <div>
              <div className="dash-alert dash-alert-error" role="alert">
                {conflictDates.length === 1
                  ? ar
                    ? `تمّ رفع بيانات حضور يوم ${conflictDates[0]} من قبل. هل تريد استبدالها بهذا الكشف؟`
                    : `Attendance for ${conflictDates[0]} was already uploaded. Replace it with this sheet?`
                  : ar
                  ? `تمّ رفع بيانات حضور الأيام التالية من قبل: ${conflictDates.join(
                      ', '
                    )}. هل تريد استبدالها بهذا الكشف؟`
                  : `Attendance for these days was already uploaded: ${conflictDates.join(
                      ', '
                    )}. Replace them with this sheet?`}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="dash-btn-ghost"
                  disabled={committing}
                  onClick={() => {
                    resetUploadFlow();
                  }}
                >
                  {ar ? 'لا' : 'No'}
                </button>
                <button
                  type="button"
                  className="dash-btn-gold"
                  disabled={committing}
                  onClick={() => commitUpload(true)}
                >
                  {committing ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'نعم' : 'Yes'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Uploaded files — collapsed by default; opening it is a deliberate act,
          since every action inside is destructive or rewrites stored days. */}
      {!permsLoading && canUpload && (
        <details className="dash-card" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {ar ? 'ملفات الحضور المرفوعة' : 'Uploaded attendance files'}
            {uploads.length > 0 && ` (${uploads.length})`}
          </summary>
          <div style={{ marginTop: 12 }}>
            {uploadsError && (
              <div className="dash-alert dash-alert-error" role="alert">
                {uploadsError}
              </div>
            )}
            {uploadsLoading ? (
              <p className="dash-subtitle" style={{ margin: 0 }}>
                …
              </p>
            ) : uploads.length === 0 ? (
              <p className="dash-subtitle" style={{ margin: 0 }}>
                {ar ? 'لم يُرفع أي ملف بعد.' : 'No files have been uploaded yet.'}
              </p>
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>{ar ? 'الملف' : 'File'}</th>
                      <th>{ar ? 'الفترة' : 'Period'}</th>
                      <th>{ar ? 'الأيام' : 'Days'}</th>
                      <th>{ar ? 'رفعه' : 'Uploaded by'}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {uploads.map((u) => {
                      const by =
                        (ar ? u.uploadedByNameAr : u.uploadedByNameEn) ||
                        u.uploadedByNameEn ||
                        u.uploadedByNameAr ||
                        '—';
                      const busy = busyUploadId === u.id;
                      return (
                        <tr key={u.id}>
                          <td>
                            <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>
                              {u.fileName}
                            </div>
                            <div className="dash-hint" dir="auto">
                              {formatDate(u.createdAt.slice(0, 10), lang)}
                            </div>
                          </td>
                          <td className="dash-td-muted" dir="ltr">
                            {u.dateStart
                              ? u.dateStart === u.dateEnd
                                ? u.dateStart
                                : `${u.dateStart} → ${u.dateEnd ?? ''}`
                              : '—'}
                          </td>
                          <td className="dash-td-muted">{u.recordCount}</td>
                          <td className="dash-td-muted">{by}</td>
                          <td>
                            {confirmDeleteId === u.id ? (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  gap: 6,
                                  alignItems: 'center',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                <span style={{ fontSize: 12.5, color: '#C24A3C' }}>
                                  {ar
                                    ? `حذف ${u.recordCount} يومًا؟`
                                    : `Delete ${u.recordCount} recorded day(s)?`}
                                </span>
                                <button
                                  type="button"
                                  className="dash-btn-ghost"
                                  style={{ padding: '3px 9px', fontSize: 12.5 }}
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  {ar ? 'لا' : 'No'}
                                </button>
                                <button
                                  type="button"
                                  className="dash-btn-ghost"
                                  style={{
                                    padding: '3px 9px',
                                    fontSize: 12.5,
                                    borderColor: '#C24A3C',
                                    color: '#C24A3C',
                                  }}
                                  disabled={busy}
                                  onClick={() => deleteUpload(u.id)}
                                >
                                  {ar ? 'نعم، احذف' : 'Yes, delete'}
                                </button>
                              </span>
                            ) : (
                              <span
                                style={{ display: 'inline-flex', gap: 6, whiteSpace: 'nowrap' }}
                              >
                                <a
                                  className="dash-btn-ghost"
                                  style={{ padding: '3px 9px', fontSize: 12.5 }}
                                  href={`/api/companies/${encodeURIComponent(companyId)}/attendance/uploads/${encodeURIComponent(u.id)}/file`}
                                  download={u.fileName}
                                >
                                  {ar ? 'تنزيل' : 'Download'}
                                </a>
                                <button
                                  type="button"
                                  className="dash-btn-ghost"
                                  style={{ padding: '3px 9px', fontSize: 12.5 }}
                                  disabled={busy || u.recordCount === 0}
                                  onClick={() => editUpload(u.id)}
                                >
                                  {ar ? 'تعديل' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  className="dash-btn-ghost"
                                  style={{
                                    padding: '3px 9px',
                                    fontSize: 12.5,
                                    borderColor: '#C24A3C',
                                    color: '#C24A3C',
                                  }}
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteId(u.id)}
                                >
                                  {ar ? 'حذف' : 'Delete'}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </details>
      )}

      {canSeeSummary && (
        <div className="dash-card" style={{ padding: 0 }}>
          <div style={{ padding: 16 }}>
            <div className="dash-eyebrow">
              {ar ? 'ملخص الفترة الحالية' : 'Current period summary'}
              {/* Name the cycle by its END month: it runs 25th→24th and so
                  spans two calendar months. */}
              {period && ` — ${formatMonthLong(period.end, lang)}`}
            </div>
            {period && (
              <p className="dash-hint" style={{ margin: '4px 0 0' }} dir="auto">
                {formatDate(period.start, lang)} – {formatDate(period.end, lang)}
              </p>
            )}
          </div>
          {summaryLoading ? (
            <p className="dash-subtitle" style={{ padding: '0 16px 16px' }}>
              …
            </p>
          ) : summaryError ? (
            <div className="dash-alert dash-alert-error" role="alert" style={{ margin: 16 }}>
              {ar ? 'تعذّر تحميل الملخص.' : 'Could not load the summary.'}
            </div>
          ) : summary.length === 0 ? (
            <p className="dash-subtitle" style={{ padding: '0 16px 16px' }}>
              {ar ? 'لا توجد بيانات حضور لهذه الفترة بعد.' : 'No attendance data for this period yet.'}
            </p>
          ) : (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>{ar ? 'الاسم' : 'Name'}</th>
                    <th>{ar ? 'التأخير' : 'Late'}</th>
                    <th>{ar ? 'المغادرة المبكرة' : 'Early out'}</th>
                    <th>{ar ? 'الإجمالي' : 'Total'}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => {
                    const total = row.totalLateMinutes + row.totalEarlyOutMinutes;
                    return (
                      <tr key={row.userId}>
                        <td>{(ar ? row.nameAr : row.nameEn) || row.nameEn || row.nameAr || '—'}</td>
                        <td style={row.totalLateMinutes > 0 ? { color: '#C24A3C' } : undefined}>
                          {formatMinutesDuration(row.totalLateMinutes, lang)}
                        </td>
                        <td style={row.totalEarlyOutMinutes > 0 ? { color: '#C24A3C' } : undefined}>
                          {formatMinutesDuration(row.totalEarlyOutMinutes, lang)}
                        </td>
                        <td
                          style={{
                            fontWeight: 600,
                            ...(total > 0 ? { color: '#C24A3C' } : {}),
                          }}
                        >
                          {formatMinutesDuration(total, lang)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
