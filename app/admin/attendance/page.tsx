import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import AttendanceView from '@/components/AttendanceView';
import {
  requirePlatformUser,
  reachesAdmin,
  hasAttendancePermissionAnywhere,
} from '@/lib/platform/auth';
import { companiesWithCapability } from '@/lib/platform/capabilityGrants';

export const metadata = { title: 'Attendance — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * Attendance screen. Admin/manager always; an otherwise-plain employee also
 * reaches it if granted can_upload_attendance (lib/platform/permissions.ts —
 * same pattern as the Folders page) OR the capability-tree-only
 * 'attendance.viewAll' (no legacy boolean — see capabilityGrants.ts).
 */
export default async function AttendancePage() {
  const pu = await requirePlatformUser();
  if (!reachesAdmin(pu) && !hasAttendancePermissionAnywhere(pu)) {
    const granted = await companiesWithCapability(pu.userId, 'attendance.viewAll');
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
    <DashboardShell identity={identity} companies={pu.companies} active="attendance">
      <AttendanceView />
    </DashboardShell>
  );
}
