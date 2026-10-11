import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import EmployeesView from '@/components/EmployeesView';
import { requirePlatformUser, isManagerAnywhere } from '@/lib/platform/auth';
import { companiesWithAnyCapability } from '@/lib/platform/capabilityGrants';

export const metadata = { title: 'Employees — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Employees directory — admin, a manager (of at least one company; the API
// further scopes reads/writes to companies they actually manage), or an
// otherwise-plain employee granted any 'people.*' capability in at least one
// company (the API re-enforces per-company and per-field below). Anyone else
// who navigates here directly is bounced to /admin.
export default async function EmployeesPage() {
  const pu = await requirePlatformUser();
  if (!pu.isAdmin && !isManagerAnywhere(pu)) {
    const granted = await companiesWithAnyCapability(pu.userId, [
      'people.view',
      'people.schedule',
      'people.zkteco',
      'people.permissions',
    ]);
    if (granted.size === 0) redirect('/admin');
  }

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="employees">
      <EmployeesView />
    </DashboardShell>
  );
}
