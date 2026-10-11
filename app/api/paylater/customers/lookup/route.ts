import { NextResponse, type NextRequest } from 'next/server';
import { resolvePaylater } from '@/app/collections/guard';
import { findSiblingsByQid } from '@/lib/platform/paylater';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/paylater/customers/lookup?qid=…&exclude=…
 *
 * "Is this QID already on another file?" — asked by the customer form as the
 * number is typed, so a duplicate shows up in the alerts panel immediately
 * rather than at the moment somebody presses save.
 *
 * The prototype could answer this from an in-memory store; here it needs a
 * round trip, so the form debounces and this route stays deliberately thin.
 *
 * EXACT MATCH ONLY, like the save path. Search elsewhere widens to the
 * trailing-zero variant because offering a person more rows to read is
 * harmless; treating two QIDs as the same file is not.
 */
export async function GET(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  const qid = (req.nextUrl.searchParams.get('qid') ?? '').trim();
  const exclude = req.nextUrl.searchParams.get('exclude');
  if (!/^\d{6,14}$/.test(qid)) {
    return NextResponse.json({ ok: true, found: null });
  }

  try {
    /*
      THE SIBLINGS DECIDE, not a single arbitrary row.

      This used to ask for ONE row with this QID and call it a duplicate unless
      it happened to be the file being edited. With three files sharing a QID
      the database's arbitrary first row was as likely to be this one, and the
      banner then said there was no duplicate at all — the check silently
      passed exactly when it mattered most.

      Excluding first and reading what is left cannot do that: what remains is
      every OTHER file this person holds, and the banner names the first of
      them.
    */
    const others = await findSiblingsByQid(ctx.companyId, qid, exclude);
    if (others.length === 0) {
      return NextResponse.json({ ok: true, found: null, others: [] });
    }
    const first = others[0];
    return NextResponse.json({
      ok: true,
      found: {
        id: first.id,
        name: first.nameAr || first.nameEn || qid,
        batchCode: first.batchCode,
      },
      others,
    });
  } catch (err) {
    console.error('PayLater QID lookup error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
