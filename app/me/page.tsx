import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import EmployeeHome from '@/components/EmployeeHome';
import InstructionsGuide from '@/components/InstructionsGuide';
import MyTasksView from '@/components/MyTasksView';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'My workspace — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Employee placeholder shell. Admins/managers are redirected to /admin.
export default async function MePage({
  searchParams,
}: {
  searchParams: { f?: string };
}) {
  const pu = await requirePlatformUser();
  if (reachesAdmin(pu)) redirect('/admin');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  // Employee sub-view selector. `?f=instructions` → the guide; `?f=files` →
  // My Files; DEFAULT → My Tasks.
  //
  // The default used to be My Files. Tasks are what an employee opens the
  // portal to find out — what has been asked of them — and their folders are
  // how they then do it, so tasks is both the first item in the sidebar and
  // the landing. `?f=tasks` is still honoured: it was the old address for this
  // view and links to it exist.
  const showInstructions = searchParams.f === 'instructions';
  const showFiles = searchParams.f === 'files';
  const active = showInstructions
    ? 'instructions'
    : showFiles
    ? 'myfiles'
    : 'mytasks';

  return (
    <DashboardShell identity={identity} companies={pu.companies} active={active}>
      {showInstructions ? (
        <InstructionsGuide />
      ) : showFiles ? (
        <EmployeeHome />
      ) : (
        <MyTasksView />
      )}
    </DashboardShell>
  );
}
