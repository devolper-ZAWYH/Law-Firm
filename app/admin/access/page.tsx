import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import AccessRequestsView from '@/components/AccessRequestsView';
import { requirePlatformUser, canAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'Access Requests — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * Admin "Access Requests" screen (Phase 3). Reviewing/approving requests is a
 * global-admin action, so managers/employees are redirected away. The client
 * view fetches /api/access-requests (also admin-guarded server-side).
 */
export default async function AdminAccessPage() {
  const pu = await requirePlatformUser();
  if (!canAdmin(pu)) redirect('/admin');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="access">
      <AccessRequestsView />
    </DashboardShell>
  );
}
