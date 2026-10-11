'use client';

import { useDash, type ShellCompany } from './DashboardShell';
import AttendanceBanner from './AttendanceBanner';
import OverviewAttendanceSummary from './OverviewAttendanceSummary';

/**
 * Overview panel for the platform admin shell. Shows the signed-in identity and
 * which companies / roles the caller has (Phase 1: identity + access summary;
 * files/tasks/etc. arrive in later phases).
 */
export default function PlatformOverview({
  companies,
}: {
  companies: ShellCompany[];
}) {
  const { t, lang, identity, activeCompany } = useDash();

  /**
   * Who sees the attendance summary on the overview.
   *
   * Mirrors the server-side gate on GET /api/companies/:id/attendance/summary
   * (canAdmin || isManagerOfCompany) and the same check inside AttendanceView,
   * so the three agree. This used to read `identity.isAdmin` alone, which hid
   * the panel from managers even though the API would happily serve them —
   * managers are exactly the people who need to see their team's lateness.
   *
   * `isManager` is checked independently of the global admin flag so an admin
   * who also manages the active company still qualifies via either path.
   */
  const isManagerHere =
    activeCompany?.role === 'manager' || activeCompany?.isManager === true;
  const canSeeAttendance = identity.isAdmin || isManagerHere;

  const displayName =
    (lang === 'ar' ? identity.fullNameAr : identity.fullNameEn) ||
    identity.fullNameEn ||
    identity.username;

  const companyName = (c: ShellCompany) =>
    lang === 'ar' ? c.nameAr : c.nameEn;

  const rolePill = (role: ShellCompany['role']) => {
    if (role === 'admin')
      return { cls: 'dash-pill-gold', label: t.globalAdmin };
    if (role === 'manager')
      return { cls: 'dash-pill-green', label: t.roleManager };
    return { cls: 'dash-pill-indigo', label: t.roleEmployee };
  };

  return (
    <>
      <h1 className="dash-title">{t.welcomeBack}</h1>
      <p className="dash-subtitle">{t.signedInReassurance}</p>

      <AttendanceBanner />

      <div className="dash-card">
        {identity.isAdmin && (
          <span className="dash-chip dash-chip-gold">{t.globalAdmin}</span>
        )}
        <div className="dash-meta">
          <div>
            <div className="dash-eyebrow">{t.name}</div>
            <div className="dash-value">{displayName}</div>
          </div>
          <div>
            <div className="dash-eyebrow">{t.signedInAs}</div>
            <div className="dash-value" dir="ltr">
              {identity.username}
            </div>
          </div>
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 20 }}>
        <div className="dash-section-header">
          <span className="dash-sq dash-sq-gold" aria-hidden="true" />
          {t.yourCompanies}
          <span className="dash-count">{companies.length}</span>
        </div>

        {companies.length === 0 ? (
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.noCompanies}
          </p>
        ) : (
          <div className="dash-company-list">
            {companies.map((c) => {
              const pill = rolePill(c.role);
              return (
                <div key={c.id} className="dash-company-row">
                  <span className="dash-company-name">{companyName(c)}</span>
                  <span className={`dash-pill ${pill.cls}`}>{pill.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {canSeeAttendance && <OverviewAttendanceSummary />}
    </>
  );
}
