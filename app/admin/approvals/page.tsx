import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import ApprovalsView from '@/components/ApprovalsView';
import { requirePlatformUser, canAdmin } from '@/lib/platform/auth';

export const metadata = { title: 'Approvals — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * The approving manager's inbox for held capability actions.
 *
 * PAGE GATE vs DATA GATE. This page admits any admin or manager of some
 * company; who may actually SEE or DECIDE a request is enforced by
 * /api/approvals and /api/approvals/:id/decide, which answer only the
 * company's assigned approver. A manager who is not the approver therefore
 * reaches a page that tells them so — better than a redirect that leaves them
 * guessing why the nav link did nothing.
 */
export default async function AdminApprovalsPage() {
  const pu = await requirePlatformUser();
  const isManagerSomewhere = pu.companies.some((c) => c.isManager || c.role === 'manager');
  if (!canAdmin(pu) && !isManagerSomewhere) redirect('/admin');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="approvals">
      <ApprovalsView />
    </DashboardShell>
  );
}
