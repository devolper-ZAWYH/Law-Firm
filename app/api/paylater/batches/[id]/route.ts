import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import { canAdmin } from '@/lib/platform/auth';
// paylaterTestMode — TEMPORARY, see lib/platform/paylaterTestMode.ts

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/paylater/batches/[id] — remove a batch.
 *
 * ADMIN ONLY, and stricter than the rest of the portal on purpose. Creating a
 * batch is a Team Leader action; removing one is not the same shape of
 * decision, and this is the only destructive operation in the portal.
 *
 * AN EMPTY BATCH ONLY. A batch holding files is refused, with the count, and
 * this is deliberate rather than a limitation:
 *
 *   • Those files are client debt records that reached the system through an
 *     import which reconciled against the firm's own Dashboard totals. Deleting
 *     a hundred of them because a folder looked wrong is not recoverable from
 *     inside the product — the notices, case numbers and enforcement state go
 *     with them.
 *   • The real need this serves is a batch created by mistake, which by
 *     definition has nothing in it.
 *
 * The database agrees independently: paylater_customers.batch_id is
 * `on delete restrict` (#34), so even a bug here cannot take files with it.
 * The check below exists to give a person a sentence instead of a constraint
 * violation.
 *
 * Emptying a batch first is possible — files are deleted one at a time from
 * their own screens — so nothing is permanently un-removable; it just cannot
 * happen in one unconsidered click.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!canAdmin(ctx.pu)) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();

  try {
    // Scoped by company as well as id: a batch belonging to another company
    // must read as absent, not as refused.
    const { data: batch, error: bErr } = await supabase
      .from('paylater_batches')
      .select('id, code')
      .eq('id', params.id)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!batch) {
      return NextResponse.json({ ok: false, error: 'No such batch.' }, { status: 404 });
    }

    const { count, error: cErr } = await supabase
      .from('paylater_customers')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId)
      .eq('batch_id', params.id);
    if (cErr) throw cErr;

    // `?force=1` — remove a batch that still holds files, and its files with
    // it. ADMIN ONLY, which the check at the top of this handler has already
    // established; this was previously gated on the temporary rehearsal flag
    // (lib/platform/paylaterTestMode.ts) and is now a standing admin power.
    //
    // The confirmation is not a dialog. The client makes the admin TYPE the
    // batch code, because a single OK once removed E100 — a hundred real client
    // files with their orders, notices and ID cards — from a button sitting
    // beside two harmless ones. The route still reports what it removed.
    const force = new URL(req.url).searchParams.get('force') === '1';

    if ((count ?? 0) > 0 && force) {
      // The ID cards live in Storage, which no foreign key reaches: collect
      // their paths before the rows that name them are gone.
      const { data: docs } = await supabase
        .from('paylater_documents')
        .select('storage_path, paylater_customers!inner(batch_id)')
        .eq('paylater_customers.batch_id', params.id);
      const paths = (docs ?? [])
        .map((d) => (d as { storage_path: string }).storage_path)
        .filter(Boolean);
      if (paths.length) {
        await supabase.storage.from('paylater-documents').remove(paths);
      }

      // Orders, documents, history, issues and exceptions all cascade from the
      // customer row (#34), so deleting the customers is the whole job.
      const { error: cdErr } = await supabase
        .from('paylater_customers')
        .delete()
        .eq('company_id', ctx.companyId)
        .eq('batch_id', params.id);
      if (cdErr) throw cdErr;

      const { error: fdErr } = await supabase
        .from('paylater_batches')
        .delete()
        .eq('id', params.id)
        .eq('company_id', ctx.companyId);
      if (fdErr) throw fdErr;

      return NextResponse.json({
        ok: true,
        code: batch.code,
        deletedFiles: count ?? 0,
        deletedDocuments: paths.length,
      });
    }

    if ((count ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: false,
          fileCount: count,
          error: `Batch ${batch.code} still holds ${count} file${count === 1 ? '' : 's'}. Only an empty batch can be deleted.`,
        },
        { status: 409 }
      );
    }

    const { error: dErr } = await supabase
      .from('paylater_batches')
      .delete()
      .eq('id', params.id)
      .eq('company_id', ctx.companyId);
    if (dErr) throw dErr;

    return NextResponse.json({ ok: true, code: batch.code });
  } catch (err) {
    console.error('PayLater delete batch error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
