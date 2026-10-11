import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import FilesView from '@/components/FilesView';
import {
  requirePlatformUser,
  reachesAdmin,
  hasFilePermissionAnywhere,
} from '@/lib/platform/auth';

export const metadata = { title: 'Files — AlBaker Platform' };
export const dynamic = 'force-dynamic';

/**
 * Files screen (Phase 2), inside the admin/manager platform shell. It is
 * active-company scoped: the client FilesView reads the active company from the
 * shell context and fetches /api/files, which re-enforces company isolation
 * server-side. Employees have no Files nav — send them to their placeholder.
 */
export default async function AdminFilesPage() {
  const pu = await requirePlatformUser();
  // An otherwise-plain employee still reaches this ONE page if they've been
  // granted an extra file permission (lib/platform/permissions.ts) — every
  // other admin page keeps the plain reachesAdmin-only gate.
  if (!reachesAdmin(pu) && !hasFilePermissionAnywhere(pu)) redirect('/me');

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="files">
      <FilesView />
    </DashboardShell>
  );
}
