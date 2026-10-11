import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/paylater/issues/[id]/confirm — someone answers a flagged guess.
 *
 * The one that matters is D100 #31. Recording WHO confirmed it and WHEN is the
 * point: the value stops being an unattributed assumption and becomes a
 * decision with a name on it. The import preserves these confirmations across
 * re-runs for exactly that reason.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canLead) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_data_issues')
      .update({
        confirmed_by: ctx.pu.userId,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', params.id)
      .eq('company_id', ctx.companyId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: 'No such note.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PayLater confirm issue error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
