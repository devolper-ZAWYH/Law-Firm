import PaylaterShell from '@/components/collections/PaylaterShell';
import NotesView from '@/components/collections/NotesView';
import { requirePaylater } from '@/app/collections/guard';
import { listDataIssues, listBatchBriefs } from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — Notes' };
export const dynamic = 'force-dynamic';

export default async function PaylaterNotesPage() {
  const { pu, companyId, access } = await requirePaylater();

  const [issues, batches] = await Promise.all([
    listDataIssues(companyId),
    listBatchBriefs(companyId),
  ]);
  const batchCode = new Map(batches.map((b) => [b.id, b.code]));

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
      active="notes"
    >
      {/*
        Confirming a flagged guess is a LEAD action — D100 #31 is the one that
        matters, and it should be the Team Leader or a manager who answers it.
      */}
      <NotesView
        issues={issues.map((i) => ({
          id: i.id,
          kind: i.kind,
          severity: i.severity,
          detail: i.detail,
          resolution: i.resolution,
          confirmedAt: i.confirmed_at,
          batchCode: i.batch_id ? (batchCode.get(i.batch_id) ?? null) : null,
        }))}
        canConfirm={access.canLead}
      />
    </PaylaterShell>
  );
}
