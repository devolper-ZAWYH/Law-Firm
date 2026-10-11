import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import UsersManagement from '@/components/UsersManagement';
import { requirePlatformUser, canAdmin } from '@/lib/platform/auth';
import { listUsers } from '@/lib/users';

export const metadata = { title: 'User Accounts — AlBaker Platform' };

// Always render fresh (reflects newly created users).
export const dynamic = 'force-dynamic';

// Real, global user-account management. Admin only (managers are redirected).
export default async function AdminUsersPage() {
  const pu = await requirePlatformUser();
  if (!canAdmin(pu)) redirect('/admin');

  const users = await listUsers();
  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="accounts">
      <UsersManagement users={users} />
    </DashboardShell>
  );
}
