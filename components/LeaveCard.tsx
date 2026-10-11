'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatDate } from '@/lib/format';

/**
 * Booked leave for the company's employees — the Attendance tab's Leave card.
 *
 * Booking leave does two things beyond recording it: no new task may be
 * assigned to that person while they are away (enforced server-side in
 * createTask, not just here), and each working day in the range is recorded as
 * an attendance VACATION day, so an uploaded sheet never counts a booked holiday
 * as an absence.
 *
 * Shown only to a caller holding 'attendance.leave' (admin and managers have it
 * by baseline). Whole days only.
 */

interface LeavePeriodDTO {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  note: string | null;
}

interface CompanyMember {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string;
}

export default function LeaveCard({ companyId }: { companyId: string }) {
  const { lang } = useDash();
  const ar = lang === 'ar';

  const [periods, setPeriods] = useState<LeavePeriodDTO[]>([]);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [leaveRes, memberRes] = await Promise.all([
        fetch(`/api/companies/${encodeURIComponent(companyId)}/leave`, {
          cache: 'no-store',
        }),
        fetch(`/api/companies/${encodeURIComponent(companyId)}/employees`, {
          cache: 'no-store',
        }),
      ]);
      const leaveData = (await leaveRes.json().catch(() => ({}))) as {
        ok?: boolean;
        periods?: LeavePeriodDTO[];
      };
      const memberData = (await memberRes.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: CompanyMember[];
      };
      if (!leaveRes.ok || !leaveData.ok) {
        setLoadError(true);
        setPeriods([]);
      } else {
        setPeriods(Array.isArray(leaveData.periods) ? leaveData.periods : []);
      }
      if (memberRes.ok && memberData.ok && Array.isArray(memberData.members)) {
        setMembers(memberData.members);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const nameOf = useCallback(
    (id: string) => {
      const m = members.find((x) => x.userId === id);
      if (!m) return id.slice(0, 8);
      return (ar ? m.nameAr || m.nameEn : m.nameEn || m.nameAr) || m.email || id;
    },
    [members, ar]
  );

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !startDate || !endDate) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/leave`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            start_date: startDate,
            end_date: endDate,
            note: note.trim() || undefined,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        // Includes the 409 "already has leave booked over those dates".
        setErr(
          data.error || (ar ? 'تعذّر حفظ الإجازة.' : 'Could not save the leave.')
        );
        setSaving(false);
        return;
      }
      setUserId('');
      setStartDate('');
      setEndDate('');
      setNote('');
      setMsg(ar ? 'تم تسجيل الإجازة.' : 'Leave booked.');
      setSaving(false);
      await load();
    } catch {
      setErr(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setSaving(false);
    }
  }

  async function onRemove(id: string) {
    setRemovingId(id);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/companies/${encodeURIComponent(companyId)}/leave/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setErr(
          data.error || (ar ? 'تعذّر إلغاء الإجازة.' : 'Could not cancel the leave.')
        );
        setRemovingId(null);
        return;
      }
      setRemovingId(null);
      await load();
    } catch {
      setErr(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setRemovingId(null);
    }
  }

  return (
    <div className="dash-card" style={{ marginBottom: 16 }}>
      <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
        {ar ? 'الإجازات' : 'Leave'}
      </div>
      <p className="dash-hint" style={{ margin: '0 0 12px' }}>
        {ar
          ? 'الموظف في إجازة لا يمكن إسناد مهام جديدة له، وتُسجَّل أيام الإجازة كإجازة في كشف الحضور.'
          : 'Someone on leave cannot be given new tasks, and those days are recorded as vacation on the attendance sheet.'}
      </p>

      {err && (
        <div className="dash-alert dash-alert-error" role="alert">
          {err}
        </div>
      )}
      {msg && (
        <div className="dash-alert dash-alert-ok" role="status">
          {msg}
        </div>
      )}

      <form onSubmit={onAdd} noValidate>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="leave-employee">
            {ar ? 'الموظف' : 'Employee'}
          </label>
          <select
            id="leave-employee"
            className="dash-input"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
          >
            <option value="">{ar ? 'اختر موظفًا…' : 'Select an employee…'}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {nameOf(m.userId)}
              </option>
            ))}
          </select>
        </div>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="leave-start">
            {ar ? 'من' : 'From'}
          </label>
          <input
            id="leave-start"
            type="date"
            className="dash-input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </div>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="leave-end">
            {ar ? 'إلى (شامل)' : 'To (inclusive)'}
          </label>
          <input
            id="leave-end"
            type="date"
            className="dash-input"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => setEndDate(e.target.value)}
            required
          />
        </div>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="leave-note">
            {ar ? 'ملاحظة (اختياري)' : 'Note (optional)'}
          </label>
          <input
            id="leave-note"
            className="dash-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="dash-btn-gold"
          disabled={saving || !userId || !startDate || !endDate}
        >
          {saving
            ? ar
              ? 'جارٍ الحفظ…'
              : 'Saving…'
            : ar
            ? 'تسجيل إجازة'
            : 'Book leave'}
        </button>
      </form>

      <div style={{ marginTop: 18 }}>
        <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
          {ar ? 'الإجازات الحالية والقادمة' : 'Current and upcoming leave'}
        </div>
        {loading ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            …
          </p>
        ) : loadError ? (
          <div className="dash-alert dash-alert-error" role="alert">
            {ar ? 'تعذّر تحميل الإجازات.' : 'Could not load leave.'}
          </div>
        ) : periods.length === 0 ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            {ar ? 'لا توجد إجازات مسجّلة.' : 'No leave booked.'}
          </p>
        ) : (
          <ul className="access-list">
            {periods.map((p) => (
              <li key={p.id} className="access-pill">
                <span className="access-pill-name">
                  {nameOf(p.userId)} · {formatDate(p.startDate, lang)} →{' '}
                  {formatDate(p.endDate, lang)}
                  {p.note ? ` · ${p.note}` : ''}
                </span>
                <button
                  type="button"
                  className="access-remove"
                  onClick={() => onRemove(p.id)}
                  disabled={removingId === p.id}
                >
                  {removingId === p.id
                    ? ar
                      ? 'جارٍ الإلغاء…'
                      : 'Removing…'
                    : ar
                    ? 'إلغاء'
                    : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
