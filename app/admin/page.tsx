import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import PlatformOverview from '@/components/PlatformOverview';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'Dashboard — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Multi-company admin/manager dashboard (replaces the old role panel).
export default async function AdminPage() {
  const pu = await requirePlatformUser();
  // Employees have no admin shell — send them to their placeholder.
  if (!reachesAdmin(pu)) redirect('/me');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="overview">
      <PlatformOverview companies={pu.companies} />
    </DashboardShell>
  );
}
