import { notFound } from 'next/navigation';
import PaylaterShell from '@/components/collections/PaylaterShell';
import BatchView from '@/components/collections/BatchView';
import { requirePaylater } from '@/app/collections/guard';
import {
  listBatchBriefs,
  listCustomers,
  assignFileNumbers,
  listAssignableMembers,
} from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — Batch' };
export const dynamic = 'force-dynamic';

export default async function PaylaterBatchPage({
  params,
}: {
  params: { id: string };
}) {
  const { pu, companyId, access } = await requirePaylater();

  // listBatchBriefs is company-scoped, so a batch id belonging to another
  // company simply is not in the list — the 404 is the boundary, not a separate
  // check.
  //
  // This used to call listBatches, which reads every customer in the company to
  // count them, and it was awaited BEFORE the customer load rather than beside
  // it. BatchView needs the batch list anyway (the bulk-reports picker), so the
  // list is still loaded — just without the counts nothing on this screen
  // shows, and now in parallel with the rows.
  const [batches, customers, assignable] = await Promise.all([
    listBatchBriefs(companyId),
    listCustomers(companyId, params.id),
    // Only a lead divides the batch, so only a lead needs the list.
    access.canLead ? listAssignableMembers(companyId) : Promise.resolve([]),
  ]);
  const batch = batches.find((b) => b.id === params.id);
  if (!batch) notFound();

  // File numbers are computed, not stored: they come from QID order within the
  // batch and would change every time someone is added. See assignFileNumbers.
  const numbers = assignFileNumbers(
    customers.map((c) => ({ id: c.id, qid: c.qid, fileNoManual: null }))
  );

  const rows = customers.map((c) => ({
    ...c,
    fileNo: numbers.get(c.id)?.number ?? '',
    fileNoManual: numbers.get(c.id)?.manual ?? false,
  }));

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
        canLead gates the bulk notice-date bar — assigning notice dates is the
        Team Leader's job in the journey. The route re-checks it.
      */}
      <BatchView
        batch={{ id: batch.id, code: batch.code, month: batch.month, capacity: batch.capacity }}
        batches={batches}
        rows={rows}
        canLead={access.canLead}
        canEditFiles={access.canEditFiles}
        canDeleteFiles={access.canDeleteFiles}
        canDeleteBatch={pu.isAdmin}
        assignable={assignable}
        currentUserId={pu.userId}
      />
    </PaylaterShell>
  );
}
