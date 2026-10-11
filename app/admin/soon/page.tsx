import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import ComingSoon from '@/components/ComingSoon';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'Coming soon — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// "Coming in a later phase" destinations for the admin/manager nav.
const KNOWN = [
  'files',
  'contacts',
  'employees',
  'access',
  'settings',
  'instructions',
  'mytasks',
  'emptasks',
];

export default async function AdminSoonPage({
  searchParams,
}: {
  searchParams: { f?: string };
}) {
  const pu = await requirePlatformUser();
  if (!reachesAdmin(pu)) redirect('/me');

  const f =
    typeof searchParams.f === 'string' && KNOWN.includes(searchParams.f)
      ? searchParams.f
      : 'files';

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active={f}>
      <ComingSoon feature={f} />
    </DashboardShell>
  );
}
