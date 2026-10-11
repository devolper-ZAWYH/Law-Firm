import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NOT exported: a Next route module may only export the HTTP verbs and its
// config, and anything else fails the generated route type.
const BUCKET = 'paylater-documents';

/** The bucket's own limit is 10 MB; this refuses earlier, with a sentence. */
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** What the document is. Free-ish, but these are the ones the portal writes. */
const KINDS = new Set(['report', 'qid', 'notice', 'judgment', 'other']);

/**
 * POST /api/paylater/documents — attach a file to a customer.
 *
 * The bytes go to Supabase Storage; the row in paylater_documents records what
 * it is, who put it there and where it sits. The row carries no URL: the bucket
 * is private and links are minted per request by the sibling route, so a path
 * leaking is not the same as a document leaking.
 *
 * THE STORAGE PATH IS company/customer/uuid-filename. Scoping by company means
 * a stray path cannot wander into another firm's documents even at the storage
 * layer, and the uuid means uploading two files called "scan.pdf" keeps both.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  // Attaching a document is part of preparing a file.
  if (!ctx.access.canEditFiles) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const file = form.get('file');
  const customerId = String(form.get('customerId') ?? '');
  const kind = String(form.get('kind') ?? 'other');

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'No file was uploaded.' }, { status: 400 });
  }
  if (!customerId) {
    return NextResponse.json({ ok: false, error: 'No customer given.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'That file is larger than 10 MB.' },
      { status: 413 }
    );
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { ok: false, error: 'Only PDFs and images can be attached.' },
      { status: 415 }
    );
  }

  const supabase = getSupabaseAdmin();

  try {
    // The customer must be this company's — the id comes from the client.
    const { data: cust, error: cErr } = await supabase
      .from('paylater_customers')
      .select('id')
      .eq('id', customerId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!cust) {
      return NextResponse.json({ ok: false, error: 'No such file.' }, { status: 404 });
    }

    const safeName = (file.name || 'document')
      .replace(/[^\w.\-]+/g, '_')
      .slice(-80);
    const path = `${ctx.companyId}/${customerId}/${crypto.randomUUID()}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, new Uint8Array(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: false,
      });
    if (upErr) throw upErr;

    const { data: row, error: rErr } = await supabase
      .from('paylater_documents')
      .insert({
        customer_id: customerId,
        kind: KINDS.has(kind) ? kind : 'other',
        storage_path: path,
        file_name: file.name?.slice(0, 300) ?? null,
        mime_type: file.type,
        size_bytes: file.size,
        uploaded_by: ctx.pu.userId,
      })
      .select('id')
      .single();
    if (rErr) {
      // Do not leave an orphan object behind if the row could not be written.
      await supabase.storage.from(BUCKET).remove([path]);
      throw rErr;
    }

    await supabase.from('paylater_history').insert({
      customer_id: customerId,
      event: 'document_added',
      actor_id: ctx.pu.userId,
      detail: { kind, fileName: file.name, sizeBytes: file.size },
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('PayLater document upload error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
