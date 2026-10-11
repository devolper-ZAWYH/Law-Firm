import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import EmployeeTasksView from '@/components/EmployeeTasksView';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';
import { companiesWithCapability } from '@/lib/platform/capabilityGrants';

export const metadata = { title: 'Employee Tasks — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * "Employee Tasks" screen (Phase 4): a read-only overview of all open tasks
 * across the active company's files. Manager/admin baseline; an otherwise-
 * plain employee still reaches this ONE page if granted 'tasks.overview' in
 * at least one company (the API re-enforces per-company below).
 */
export default async function AdminEmployeeTasksPage() {
  const pu = await requirePlatformUser();
  if (!reachesAdmin(pu)) {
    const granted = await companiesWithCapability(pu.userId, 'tasks.overview');
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
    <DashboardShell
      identity={identity}
      companies={pu.companies}
      active="emptasks"
      // A month of seven columns, each carrying a row per person, does not fit
      // the shell's 900px reading width — it was squeezing days narrower than
      // the "0/8h" printed inside them while a third of the window sat empty.
      wide
    >
      <EmployeeTasksView />
    </DashboardShell>
  );
}
