import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import InstructionsGuide from '@/components/InstructionsGuide';
import { requirePlatformUser, reachesAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'Instructions — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Instructions — a role-aware bilingual guide. Admins/managers reach it here;
// employees see the same guide via /me?f=instructions.
export default async function InstructionsPage() {
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
    <DashboardShell identity={identity} companies={pu.companies} active="instructions">
      <InstructionsGuide />
    </DashboardShell>
  );
}
