import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import { toPaylaterMonth } from '@/lib/platform/paylaterMonths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/paylater/batches — create the month's batch.
 *
 * v2 ships a hard-coded A10…F100 list, which needs a deploy to add September.
 * A Team Leader creates the batch here instead.
 *
 * Creating one is a LEAD action (Team Leaders, managers, admins). The dashboard
 * only draws the button for them; this is the check that actually decides.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canLead) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let body: { code?: unknown; month?: unknown; capacity?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  // Held to the twelve known months and stored in the canonical uppercase form
  // the Progress Report uses, so a batch created here sorts and reads exactly
  // like the seven that were imported. The IMPORTER is deliberately not held to
  // this (see lib/platform/paylaterMonths.ts) — it must be able to bring in
  // whatever the source document says, and report it rather than refuse it.
  const month = toPaylaterMonth(body.month);
  const capacity =
    body.capacity === null || body.capacity === undefined
      ? null
      : Number(body.capacity);

  if (!code) {
    return NextResponse.json(
      { ok: false, error: 'A batch code is required.' },
      { status: 400 }
    );
  }
  if (!month) {
    return NextResponse.json(
      { ok: false, error: 'Choose a month.' },
      { status: 400 }
    );
  }
  if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) {
    return NextResponse.json(
      { ok: false, error: 'Capacity must be a positive number.' },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  try {
    // The next batch number follows the highest existing one. It drives the fee
    // model (kafalah applies from batch 6), so it is stored rather than derived
    // from creation order later.
    const { data: last } = await supabase
      .from('paylater_batches')
      .select('batch_no')
      .eq('company_id', ctx.companyId)
      .order('batch_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    const batchNo = ((last?.batch_no as number | undefined) ?? 0) + 1;

    // Same fee model the import applies: 3,000 court fee throughout, plus a
    // 5,000 kafalah from batch 6 onward. Snapshotted per batch so a later
    // change to the model cannot rewrite historical totals.
    const feeModel = {
      court: 3000,
      kafalah: batchNo >= 6 ? 5000 : 0,
      enforcement: 1000,
      request: 50,
      admin: 800,
      damages_pct: 10,
    };

    const { data, error } = await supabase
      .from('paylater_batches')
      .insert({
        company_id: ctx.companyId,
        code,
        month,
        capacity,
        batch_no: batchNo,
        fee_model: feeModel,
        created_by: ctx.pu.userId,
      })
      .select('id')
      .single();

    if (error) {
      // The (company_id, code) unique index — a batch code is not reusable.
      if (error.code === '23505') {
        return NextResponse.json(
          { ok: false, error: `Batch ${code} already exists.` },
          { status: 409 }
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Create PayLater batch error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
