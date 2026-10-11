import PaylaterShell from '@/components/collections/PaylaterShell';
import SearchView from '@/components/collections/SearchView';
import { requirePaylater } from '@/app/collections/guard';
import { searchCustomers, listBatchBriefs } from '@/lib/platform/paylater';

export const metadata = { title: 'Collections — Search' };
export const dynamic = 'force-dynamic';

export default async function PaylaterSearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const { pu, companyId, access } = await requirePaylater();

  const q = (searchParams.q ?? '').trim();
  const [results, batches] = await Promise.all([
    q ? searchCustomers(companyId, q) : Promise.resolve([]),
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
      active="search"
      wide
    >
      <SearchView
        query={q}
        results={results.map((r) => ({
          ...r,
          batchCode: batchCode.get(r.batchId) ?? '',
        }))}
      />
    </PaylaterShell>
  );
}
