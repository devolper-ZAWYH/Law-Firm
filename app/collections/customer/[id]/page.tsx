import { notFound } from 'next/navigation';
import PaylaterShell from '@/components/collections/PaylaterShell';
import CustomerForm from '@/components/collections/CustomerForm';
import { requirePaylater } from '@/app/collections/guard';
import {
  getCustomer,
  listBatchBriefs,
  listAssignableMembers,
} from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — Customer' };
export const dynamic = 'force-dynamic';

export default async function PaylaterCustomerPage({
  params,
}: {
  params: { id: string };
}) {
  const { pu, companyId, access } = await requirePaylater();

  // getCustomer is company-scoped, so another company's id reads as absent.
  const [customer, batches, employees] = await Promise.all([
    getCustomer(companyId, params.id),
    listBatchBriefs(companyId),
    listAssignableMembers(companyId),
  ]);
  if (!customer) notFound();

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
      <CustomerForm
        customer={customer}
        batchId={customer.batchId}
        batchCode={customer.batchCode}
        batches={batches.map((b) => ({ id: b.id, code: b.code, month: b.month }))}
        employees={employees}
        canEditFiles={access.canEditFiles}
        canDeleteFiles={access.canDeleteFiles}
      />
    </PaylaterShell>
  );
}
