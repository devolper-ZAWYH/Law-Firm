'use client';

import { useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatMinutesDuration, formatMonthLong } from '@/lib/format';

interface MyAttendanceSummary {
  /** The last WORKING day this person has a record for — not literally
   * yesterday, so someone off Friday/Saturday still sees Thursday's mark when
   * they arrive on Sunday. */
  lastRecordedDate: string | null;
  yesterdayLateMinutes: number;
  yesterdayEarlyOutMinutes: number;
  hasYesterdayRecord: boolean;
  periodTotalLateMinutes: number;
  periodTotalEarlyOutMinutes: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * "Hello X, you were late Y mins yesterday" banner on the employee homepage,
 * plus the running total for the current 25th→25th period. The day it reports
 * is their LAST WORKING DAY — on a Sunday that is the previous Thursday, not
 * Saturday.
 *
 * READ-ONLY. Employees used to be able to object to a mark from here; that is
 * gone. Objections are now raised by whoever uploads the attendance sheet,
 * from the review table on the Attendance page, and decided by the one
 * manager the admin designates in Company settings.
 */
export default function AttendanceBanner() {
  const { lang, identity } = useDash();
  const ar = lang === 'ar';

  const [summary, setSummary] = useState<MyAttendanceSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/attendance/me', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          summary?: MyAttendanceSummary;
        };
        if (!cancelled && res.ok && data.ok && data.summary) {
          setSummary(data.summary);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !summary) return null;

  const displayName =
    (ar ? identity.fullNameAr : identity.fullNameEn) ||
    identity.fullNameEn ||
    identity.fullNameAr ||
    identity.username;

  /**
   * Name the day being reported. Saying "yesterday" was wrong the moment the
   * day in question was Thursday and today is Sunday.
   */
  const lastDayLabel = summary?.lastRecordedDate
    ? new Intl.DateTimeFormat(ar ? 'ar' : 'en', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(`${summary.lastRecordedDate}T12:00:00Z`))
    : ar
    ? 'آخر يوم عمل'
    : 'Last working day';

  const hadIssueYesterday =
    summary.hasYesterdayRecord &&
    (summary.yesterdayLateMinutes > 0 || summary.yesterdayEarlyOutMinutes > 0);

  return (
    <div className="dash-card" style={{ marginBottom: 16 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {ar ? `مرحبًا ${displayName}` : `Hello ${displayName}`}
      </p>
      <p className="dash-subtitle" style={{ margin: '4px 0 0' }}>
        {!summary.hasYesterdayRecord
          ? ar
            ? 'لا توجد بيانات حضور بعد.'
            : 'No attendance data yet.'
          : hadIssueYesterday
          ? ar
            ? `${lastDayLabel}: تأخير ${formatMinutesDuration(summary.yesterdayLateMinutes, lang)}، مغادرة مبكرة ${formatMinutesDuration(summary.yesterdayEarlyOutMinutes, lang)}.`
            : `${lastDayLabel}: ${formatMinutesDuration(summary.yesterdayLateMinutes, lang)} late, ${formatMinutesDuration(summary.yesterdayEarlyOutMinutes, lang)} early out.`
          : ar
          ? `كنت في الموعد (${lastDayLabel}).`
          : `You were on time (${lastDayLabel}).`}
      </p>
      <p className="dash-hint" style={{ margin: '4px 0 0' }} dir="auto">
        {ar ? 'إجمالي هذا الشهر: ' : 'This month total: '}
        <span
          style={
            summary.periodTotalLateMinutes + summary.periodTotalEarlyOutMinutes > 0
              ? { color: '#C24A3C' }
              : undefined
          }
        >
          {ar
            ? `${formatMinutesDuration(summary.periodTotalLateMinutes + summary.periodTotalEarlyOutMinutes, lang)} (تأخير ${formatMinutesDuration(summary.periodTotalLateMinutes, lang)}، مغادرة مبكرة ${formatMinutesDuration(summary.periodTotalEarlyOutMinutes, lang)})`
            : `${formatMinutesDuration(summary.periodTotalLateMinutes + summary.periodTotalEarlyOutMinutes, lang)} (${formatMinutesDuration(summary.periodTotalLateMinutes, lang)} late, ${formatMinutesDuration(summary.periodTotalEarlyOutMinutes, lang)} early out)`}
        </span>{' '}
        {/* Named by the period's END date. The cycle runs 25th→25th, so it
            spans two calendar months (25 Jul → 25 Aug); naming it by the START
            made it read "July" for the whole of August. */}
        {formatMonthLong(summary.periodEnd, lang)}
      </p>

    </div>
  );
}
