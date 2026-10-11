import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import SettingsView from '@/components/SettingsView';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';
import { companiesWithCapability } from '@/lib/platform/capabilityGrants';

export const metadata = { title: 'Settings — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Admin/manager always; an otherwise-plain employee also reaches this
// (read-only — the PUT route stays admin-only) if granted
// 'company.settingsView' in at least one company.
export default async function SettingsPage() {
  const pu = await requirePlatformUser();
  if (!reachesAdmin(pu)) {
    const granted = await companiesWithCapability(pu.userId, 'company.settingsView');
    if (granted.size === 0) redirect('/me');
  }

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="settings">
      <SettingsView />
    </DashboardShell>
  );
}
