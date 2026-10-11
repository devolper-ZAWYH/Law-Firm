'use client';

import { useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatDate, formatMinutesDuration, formatMonthLong } from '@/lib/format';

interface SummaryRow {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  totalLateMinutes: number;
  totalEarlyOutMinutes: number;
}

interface Period {
  start: string;
  end: string;
}

/**
 * "Total late minutes per employee" table on the Overview page, scoped to the
 * active company, for the current 25th→24th period (same data source as the
 * Attendance page's summary — lib/platform/attendance.ts).
 *
 * Shown to admins AND managers of the active company, matching the server-side
 * gate on the summary endpoint.
 */
export default function OverviewAttendanceSummary() {
  const { lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [period, setPeriod] = useState<Period | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/attendance/summary`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          summary?: SummaryRow[];
          period?: Period;
        };
        if (!cancelled) {
          if (!res.ok || !data.ok || !Array.isArray(data.summary)) {
            setError(true);
          } else {
            setSummary(data.summary);
            setPeriod(data.period ?? null);
          }
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (!companyId) return null;

  return (
    <div className="dash-card" style={{ marginTop: 20, padding: 0 }}>
      <div style={{ padding: 16 }}>
        <div className="dash-section-header" style={{ marginBottom: 0 }}>
          <span className="dash-sq dash-sq-gold" aria-hidden="true" />
          {ar ? 'إجمالي التأخير لكل موظف' : 'Total late time per employee'}
          {/* Which 25th→24th cycle these totals cover. Named by the period's
              END month — the cycle spans two calendar months. */}
          {period && (
            <span className="dash-count" style={{ fontWeight: 500 }}>
              {formatMonthLong(period.end, lang)}
            </span>
          )}
        </div>
        {period && (
          <p className="dash-hint" style={{ margin: '4px 0 0' }} dir="auto">
            {formatDate(period.start, lang)} – {formatDate(period.end, lang)}
          </p>
        )}
      </div>
      {loading ? (
        <p className="dash-subtitle" style={{ padding: '0 16px 16px' }}>
          …
        </p>
      ) : error ? (
        <div className="dash-alert dash-alert-error" role="alert" style={{ margin: 16 }}>
          {ar ? 'تعذّر تحميل بيانات الحضور.' : 'Could not load attendance data.'}
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
  );
}
