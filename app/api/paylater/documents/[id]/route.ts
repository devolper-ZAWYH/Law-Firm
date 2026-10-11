import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = 'paylater-documents';

/**
 * GET /api/paylater/documents/[id] — open one document.
 *
 * The bucket is PRIVATE, so this mints a short-lived signed URL and redirects
 * to it rather than handing out a permanent link. A link that expires in a
 * minute cannot be forwarded, bookmarked, or found in someone's history a year
 * later — which matters for a customer's ID card.
 *
 * Access is resolved before the URL is created: a lawyer or auditor may READ a
 * file, so they may open its documents; someone with no PayLater access gets
 * nothing at all.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();

  try {
    // Join through the customer so the company scope is enforced by the query
    // rather than trusted from the document row.
    const { data, error } = await supabase
      .from('paylater_documents')
      .select('storage_path, file_name, paylater_customers!inner(company_id)')
      .eq('id', params.id)
      .maybeSingle();
    if (error) throw error;

    const rel = data?.paylater_customers as
      | { company_id: string }
      | { company_id: string }[]
      | null;
    const owner = Array.isArray(rel) ? rel[0]?.company_id : rel?.company_id;

    if (!data || owner !== ctx.companyId) {
      return NextResponse.json({ ok: false, error: 'No such document.' }, { status: 404 });
    }

    const { data: signed, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(data.storage_path as string, 60);
    if (sErr) throw sErr;

    return NextResponse.redirect(signed.signedUrl);
  } catch (err) {
    console.error('PayLater document read error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/paylater/documents/[id] — remove an attachment.
 *
 * The object goes first and the row second: an orphaned row pointing at nothing
 * shows as a broken link a person can report, whereas an orphaned OBJECT is
 * invisible and stays in the bucket forever.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canEditFiles) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_documents')
      .select('id, storage_path, customer_id, paylater_customers!inner(company_id)')
      .eq('id', params.id)
      .maybeSingle();
    if (error) throw error;

    const rel = data?.paylater_customers as
      | { company_id: string }
      | { company_id: string }[]
      | null;
    const owner = Array.isArray(rel) ? rel[0]?.company_id : rel?.company_id;
    if (!data || owner !== ctx.companyId) {
      return NextResponse.json({ ok: false, error: 'No such document.' }, { status: 404 });
    }

    await supabase.storage.from(BUCKET).remove([data.storage_path as string]);
    const { error: dErr } = await supabase
      .from('paylater_documents')
      .delete()
      .eq('id', params.id);
    if (dErr) throw dErr;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PayLater document delete error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
