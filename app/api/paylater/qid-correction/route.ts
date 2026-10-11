import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The artifact: 11 real digits followed by a spurious 0. */
const TRAILING_ZERO = /^\d{11}0$/;

/**
 * POST /api/paylater/qid-correction — strip the spurious trailing zero.
 *
 * WHY THIS IS A BUTTON AND NOT SOMETHING THE IMPORT DOES.
 *
 * The import's rule is to infer nothing: it stores what the source says and
 * reports what looks wrong. That rule is right for an unattended job which runs
 * every month against a file nobody has read yet. It is not a reason to leave
 * data known to be wrong sitting under legal notices forever — the QID is
 * PRINTED ON THE NOTICE, so a wrong one is a defective legal document.
 *
 * So the correction exists, and a person triggers it, once, having seen the
 * evidence. `mode: 'preview'` reports what would change without touching
 * anything.
 *
 * THE EVIDENCE, recorded here because a future reader will ask why we were
 * confident enough to rewrite 258 client identifiers:
 *   1. Every one of the affected QIDs ends in 0. A genuine 12-digit number
 *      would spread its last digit across 0–9.
 *   2. A Qatari QID encodes [century][YY][country][serial]. Reading the first
 *      11 digits, the country code matches the customer's stated nationality
 *      at the same rate as the batches that were never affected.
 *   3. The unaffected batches (C100, D100, E100) and the four records seeded in
 *      the v2 prototype are all 11 digits.
 *
 * NOTHING IS LOST. `source_row` still holds the record exactly as imported, and
 * every change writes a history row carrying the old and new value, so this is
 * auditable and reversible per file.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  // Rewriting client identifiers across the portfolio is a lead action.
  if (!ctx.access.canLead) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let body: { mode?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* no body means preview */
  }
  const commit = body.mode === 'commit';

  const supabase = getSupabaseAdmin();

  try {
    // company_id and batch_id are selected because the upsert below has to
    // carry them — see the note there.
    const { data, error } = await supabase
      .from('paylater_customers')
      .select('id, qid, company_id, batch_id')
      .eq('company_id', ctx.companyId);
    if (error) throw error;

    const affected = (
      (data ?? []) as {
        id: string;
        qid: string | null;
        company_id: string;
        batch_id: string;
      }[]
    ).filter((c) => c.qid && TRAILING_ZERO.test(c.qid.trim()));

    const summary = {
      affected: affected.length,
      sample: affected.slice(0, 5).map((c) => ({
        from: c.qid,
        to: c.qid!.trim().slice(0, 11),
      })),
    };

    if (!commit) return NextResponse.json({ ok: true, preview: summary });

    // Chunked, so one request does not hold 258 round trips open.
    const CHUNK = 100;
    let changed = 0;
    for (let i = 0; i < affected.length; i += CHUNK) {
      const slice = affected.slice(i, i + CHUNK);

      // EVERY NOT-NULL COLUMN HAS TO BE PRESENT, even though this only ever
      // updates. `upsert` compiles to INSERT ... ON CONFLICT DO UPDATE, and
      // Postgres validates NOT NULL against the proposed INSERT row BEFORE it
      // resolves the conflict — so an id-plus-two-fields payload fails with
      // "null value in column company_id" and never reaches the update it
      // would have performed. Carrying them costs nothing and keeps this to
      // one round trip per chunk instead of 258 separate updates.
      const rows = slice.map((c) => ({
        id: c.id,
        company_id: c.company_id,
        batch_id: c.batch_id,
        qid: c.qid!.trim().slice(0, 11),
        qid_normalized: c.qid!.trim().slice(0, 11),
      }));
      const { error: uErr } = await supabase
        .from('paylater_customers')
        .upsert(rows, { onConflict: 'id' });
      if (uErr) throw uErr;

      const { error: hErr } = await supabase.from('paylater_history').insert(
        slice.map((c) => ({
          customer_id: c.id,
          event: 'qid_corrected',
          actor_id: ctx.pu.userId,
          // The old value lives here as well as in source_row, so a reader of
          // the file's history sees the change without cross-referencing.
          detail: {
            from: c.qid,
            to: c.qid!.trim().slice(0, 11),
            reason: 'trailing zero from source spreadsheet',
          },
        }))
      );
      if (hErr) throw hErr;

      changed += slice.length;
    }

    // The Notes entry stops being an open problem and becomes a record of what
    // was done, by whom. It is not deleted — the history of the data matters.
    await supabase
      .from('paylater_data_issues')
      .update({
        confirmed_by: ctx.pu.userId,
        confirmed_at: new Date().toISOString(),
        resolution: `Corrected: the trailing zero was removed from ${changed} QIDs. The original value is kept in each file's history and original data.`,
      })
      .eq('company_id', ctx.companyId)
      .eq('kind', 'qid_trailing_zero');

    return NextResponse.json({ ok: true, corrected: changed });
  } catch (err) {
    console.error('PayLater QID correction error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
