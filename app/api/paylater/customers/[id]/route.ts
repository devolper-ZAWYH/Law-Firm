import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getCustomer } from '@/lib/platform/paylater';
import { canAdmin } from '@/lib/platform/auth';
import { resolvePaylater } from '@/app/collections/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/paylater/customers/[id] — one customer file, in full.
 *
 * Exists because the file opens as a DRAWER over the batch it belongs to
 * rather than as its own page. The page still works for a direct link, and
 * renders the record server-side; the drawer has no server render to hang it
 * on, so it asks for the record here.
 *
 * WHO. Anyone who may open the portal at all. Reading a file is not gated on
 * being able to edit it — the lawyer and the auditor are read-only on intake by
 * design, and both of them need to see the file they sign for.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  try {
    // Company-scoped, so another company's id reads as absent, not refused.
    const customer = await getCustomer(ctx.companyId, params.id);
    if (!customer) {
      return NextResponse.json({ ok: false, error: 'No such file.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, customer });
  } catch (err) {
    console.error('PayLater get customer error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/paylater/customers/[id] — remove one customer file.
 *
 * v2 has a two-step delete on this screen and so does the form: the first click
 * arms the button, the second sends this. The confirmation lives in the UI
 * because that is where a mis-click happens; this route just does the work.
 *
 * WHO. Whoever may prepare a file may remove one — the Employee and the Team
 * Leader. Deleting a single customer is part of intake (a row imported twice, a
 * file opened against the wrong person), unlike deleting a BATCH, which takes a
 * hundred client records with it and is admin-only.
 *
 * The orders and the file's history go with it: paylater_orders and
 * paylater_history are both `on delete cascade` from this row (#34), so there
 * is nothing to clean up by hand and nothing left pointing at a file that is
 * gone.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  // Whoever may prepare a file may remove one — OR an admin, unconditionally.
  //
  // canEditFiles SUBTRACTS for an assigned lawyer or auditor, deliberately:
  // the person who signs a notice must not be able to change the debt it
  // claims. That rule is about EDITING the figures, and it was catching the
  // admin too — an admin who also holds a lawyer role could not remove a file
  // at all, which is not what that separation is protecting.
  if (!ctx.access.canEditFiles && !canAdmin(ctx.pu)) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  try {
    // Scoped by company as well as id, so another company's file reads as
    // absent rather than as refused.
    const { data, error } = await supabase
      .from('paylater_customers')
      .delete()
      .eq('id', params.id)
      .eq('company_id', ctx.companyId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: 'No such file.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PayLater delete customer error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
