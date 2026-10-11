import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import MyTasksView from '@/components/MyTasksView';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'My Tasks — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * Manager "My Tasks" screen (Phase 4): tasks awaiting the manager's approval
 * (where he is the named approver) plus his own open self-tasks to mark done.
 * Employees have no admin shell — send them to their placeholder.
 */
export default async function AdminMyTasksPage() {
  const pu = await requirePlatformUser();
  if (!reachesAdmin(pu)) redirect('/me');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="mytasks">
      <MyTasksView />
    </DashboardShell>
  );
}
