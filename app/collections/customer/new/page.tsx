import { notFound, redirect } from 'next/navigation';
import PaylaterShell from '@/components/collections/PaylaterShell';
import CustomerForm from '@/components/collections/CustomerForm';
import { requirePaylater } from '@/app/collections/guard';
import { listBatchBriefs, listAssignableMembers } from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — New customer' };
export const dynamic = 'force-dynamic';

export default async function PaylaterNewCustomerPage({
  searchParams,
}: {
  searchParams: { batch?: string };
}) {
  const { pu, companyId, access } = await requirePaylater();

  const [batches, employees] = await Promise.all([
    listBatchBriefs(companyId),
    listAssignableMembers(companyId),
  ]);
  const batch = batches.find((b) => b.id === searchParams.batch);
  if (!batch) notFound();

  // A read-only "new customer" form is a contradiction, so a Lawyer or Auditor
  // is sent back to the batch rather than shown an empty page they cannot
  // submit. The route refuses the write regardless.
  if (!access.canEditFiles) redirect(`/collections/batch/${batch.id}`);

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
        customer={null}
        batchId={batch.id}
        batchCode={batch.code}
        batches={batches.map((b) => ({ id: b.id, code: b.code, month: b.month }))}
        employees={employees}
        canEditFiles={access.canEditFiles}
        canDeleteFiles={access.canDeleteFiles}
      />
    </PaylaterShell>
  );
}
