'use client';

import { useDash } from './DashboardShell';

/**
 * Placeholder panel for nav destinations that are not built yet (Phase 1 wires
 * the shell so it is navigable and deploys cleanly). Every "coming soon" nav
 * item lands here.
 */
export default function ComingSoon({ feature }: { feature: string }) {
  const { t } = useDash();

  const labels: Record<string, string> = {
    files: t.navFiles,
    contacts: t.navContacts,
    employees: t.navEmployees,
    access: t.navAccessRequests,
    settings: t.navSettings,
    instructions: t.navInstructions,
    mytasks: t.navMyTasks,
    emptasks: t.navEmployeeTasks,
    myfiles: t.navMyFiles,
  };
  const label = labels[feature] ?? '';

  return (
    <>
      <h1 className="dash-title">{label || t.comingSoonTitle}</h1>
      <p className="dash-subtitle">{t.comingSoonTitle}</p>
      <div className="dash-card dash-state-card">
        <span className="dash-chip dash-chip-gold">{t.comingSoonTitle}</span>
        <p className="dash-subtitle" style={{ margin: '16px 0 0' }}>
          {t.comingSoonBody}
        </p>
      </div>
    </>
  );
}
