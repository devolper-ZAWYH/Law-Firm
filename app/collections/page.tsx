import PaylaterShell from '@/components/collections/PaylaterShell';
import PaylaterDashboard from '@/components/collections/PaylaterDashboard';
import { requirePaylater } from './guard';
import { listBatches } from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — AlBaker' };
export const dynamic = 'force-dynamic';

export default async function PaylaterPage() {
  const { pu, companyId, access } = await requirePaylater();
  const batches = await listBatches(companyId);

  return (
    <PaylaterShell
      identity={{
        username: pu.username,
        fullNameEn: pu.fullNameEn,
        fullNameAr: pu.fullNameAr,
        isAdmin: pu.isAdmin,
      }}
      role={access.role}
      byRole={access.byRole}
      active="dashboard"
      wide
    >
      {/*
        canLead decides which CONTROLS are drawn (create a batch, import a
        month's Excel). Every one of them is re-checked in its route — a wrong
        prop here costs a button that returns 403, never access.
      */}
      <PaylaterDashboard batches={batches} canLead={access.canLead} />
    </PaylaterShell>
  );
}
