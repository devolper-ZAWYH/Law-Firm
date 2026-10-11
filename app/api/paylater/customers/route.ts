import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import {
  IDENTITY_FIELDS,
  isIdentityField,
} from '@/lib/platform/paylaterIdentity';
import { findByQid } from '@/lib/platform/paylater';
import {
  isCustomerComplete,
  isCustomerCompleteFromParts,
} from '@/lib/platform/paylaterIntake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

interface OrderIn {
  id?: string | null;
  orderRef?: unknown;
  orderDate?: unknown;
  storeAr?: unknown;
  storeEn?: unknown;
  amount?: unknown;
  instalment?: unknown;
  paidCount?: unknown;
  paidTotal?: unknown;
  remaining?: unknown;
  sortIndex?: unknown;
}

/**
 * POST /api/paylater/customers — create or update one file, with its orders.
 *
 * Every field the client sends is re-read and re-validated here. The form's
 * validation exists to tell someone what is wrong while they type; THIS is the
 * check that decides, because a form is a suggestion and a route is a rule.
 *
 * ORDERS ARE REPLACED, NOT MERGED. The form owns the whole list — a row deleted
 * there must disappear here — and reconciling row-by-row would leave an order
 * the user removed alive whenever its id failed to round-trip.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  // Intake is the Employee's and Team Leader's work. A LAWYER OR AUDITOR MUST
  // NOT reach it: they sign and audit what this data produces, and someone who
  // can both alter a claim and sign the notice claiming it is not a check on
  // anything. See canEditFiles in lib/platform/paylater.ts.
  if (!ctx.access.canEditFiles) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const id = str(body.id);
  const batchId = str(body.batchId);
  const qid = str(body.qid);
  const nameAr = str(body.nameAr);
  const nameEn = str(body.nameEn);

  if (!batchId) {
    return NextResponse.json({ ok: false, error: 'A batch is required.' }, { status: 400 });
  }
  if (!qid) {
    return NextResponse.json({ ok: false, error: 'A QID is required.' }, { status: 400 });
  }
  if (!/^\d+$/.test(qid)) {
    return NextResponse.json(
      { ok: false, error: 'The QID must be digits only.' },
      { status: 400 }
    );
  }
  if (!nameAr && !nameEn) {
    return NextResponse.json({ ok: false, error: 'A name is required.' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  try {
    // The batch must be this company's.
    const { data: batch } = await supabase
      .from('paylater_batches')
      .select('id')
      .eq('id', batchId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (!batch) {
      return NextResponse.json({ ok: false, error: 'No such batch.' }, { status: 404 });
    }

    /*
      A DUPLICATE QID REFUSES A NEW FILE, AND ONLY A NEW ONE.

      Creating a second file for somebody who already has one is the mistake
      worth refusing, and this still refuses it, returning the record that holds
      the QID so the form can offer to open it.

      Applied to a file that ALREADY EXISTS it did something else: it froze the
      record. Repeat customers are ordinary — the person is the same and each
      month's debt is its own file — so this rejected every attempt to correct a
      name or confirm a gender on any of them. The form had already been
      relaxed to match; the route had not, so the save came back 409 while the
      screen showed a form that believed it was fine, and the change vanished
      with no message. That is the worst shape a bug can take: the person is
      told nothing and assumes it saved.
    */
    const existing = id ? null : await findByQid(ctx.companyId, qid);
    if (existing && existing.id !== id) {
      return NextResponse.json(
        {
          ok: false,
          error: 'That QID is already saved.',
          duplicate: {
            id: existing.id,
            name: existing.nameAr || existing.nameEn || qid,
            batchCode: existing.batchCode,
          },
        },
        { status: 409 }
      );
    }

    const ordersIn = Array.isArray(body.orders) ? (body.orders as OrderIn[]) : [];
    const orders = ordersIn.map((o, i) => ({
      orderRef: str(o.orderRef),
      orderDate: date(o.orderDate),
      storeAr: str(o.storeAr),
      storeEn: str(o.storeEn),
      amount: num(o.amount),
      instalment: num(o.instalment),
      paidCount: num(o.paidCount),
      paidTotal: num(o.paidTotal),
      remaining: num(o.remaining),
      sortIndex: num(o.sortIndex) ?? i,
    }));

    const gender = str(body.gender);
    const reportDate = date(body.reportDate);
    const paylaterRegDate = date(body.paylaterRegDate);

    // Completeness is computed here, from what is actually being written —
    // never taken from the client, or a record could claim to be complete
    // without the orders that make it so.
    const complete = isCustomerComplete({
      gender,
      reportDate,
      paylaterRegDate,
      orders,
    });

    const row = {
      company_id: ctx.companyId,
      batch_id: batchId,
      name_ar: nameAr,
      name_en: nameEn,
      qid_name: str(body.qidName),
      qid,
      // Nothing is inferred from the QID — see migration #34.
      qid_normalized: qid,
      nationality: str(body.nationality),
      gender,
      mobile: str(body.mobile),
      email: str(body.email),
      paylater_reg_date: paylaterRegDate,
      report_date: reportDate,
      debt_total: num(body.debtTotal),
      // The unit that total is in (#38). Only ever a three-letter code, and
      // QAR when the client says nothing — every file imported from the
      // monthly spreadsheet, which names no currency, is Qatari riyals.
      currency: /^[A-Z]{3}$/.test(String(body.currency ?? '')) ? String(body.currency) : 'QAR',
      instalment_count: num(body.instalmentCount),
      dpd: num(body.dpd),
      moi_check: str(body.moiCheck),
      delay_months: num(body.delayMonths),
      handler_name: str(body.handlerName),
      file_no_manual: str(body.fileNoManual),
      notice_planned: date(body.noticePlanned),
      case_reg_date: date(body.caseRegDate),
      case_number: str(body.caseNumber),
      observations: str(body.observations),
      is_complete: complete,
    };

    let customerId: string;

    if (id) {
      const { data, error } = await supabase
        .from('paylater_customers')
        .update(row)
        .eq('id', id)
        .eq('company_id', ctx.companyId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json({ ok: false, error: 'No such file.' }, { status: 404 });
      }
      customerId = data.id as string;
    } else {
      // A new file lands at the end of the batch's numbering.
      const { data: maxRow } = await supabase
        .from('paylater_customers')
        .select('row_no')
        .eq('company_id', ctx.companyId)
        .eq('batch_id', batchId)
        .order('row_no', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data, error } = await supabase
        .from('paylater_customers')
        .insert({
          ...row,
          row_no: ((maxRow?.row_no as number | undefined) ?? 0) + 1,
          stage: 'notice_planned',
          created_by: ctx.pu.userId,
        })
        .select('id')
        .single();
      if (error) throw error;
      customerId = data.id as string;
    }

    // Replace the order list wholesale — see the note above.
    await supabase.from('paylater_orders').delete().eq('customer_id', customerId);
    if (orders.length > 0) {
      const { error: oErr } = await supabase.from('paylater_orders').insert(
        orders.map((o) => ({
          customer_id: customerId,
          order_ref: o.orderRef,
          order_date: o.orderDate,
          store_ar: o.storeAr,
          store_en: o.storeEn,
          amount: o.amount,
          instalment: o.instalment,
          paid_count: o.paidCount,
          paid_total: o.paidTotal,
          remaining: o.remaining,
          sort_index: o.sortIndex,
        }))
      );
      if (oErr) throw oErr;
    }

    await supabase.from('paylater_history').insert({
      customer_id: customerId,
      event: id ? 'edited' : 'created',
      actor_id: ctx.pu.userId,
      detail: { orders: orders.length, complete },
    });

    /*
      COPYING A CORRECTION TO THE PERSON'S OTHER FILES.

      A customer can hold a file in several batches. Their DEBT is per file and
      is never touched here; what can be copied is who they are — the fields in
      IDENTITY_FIELDS, which is v2's "customer details" section. Correcting a
      misspelt name on one file otherwise leaves the others wrong, and the
      wrong one is as likely to be the one a notice is built from.

      The client asks the question and sends the answer, but decides nothing:
      the field list is filtered against IDENTITY_FIELDS here, and the target
      ids are re-checked to be this company's AND to carry the same QID. A
      request naming an arbitrary id and column would otherwise be an edit
      primitive for the whole table.
    */
    let propagated = 0;
    const wanted = Array.isArray((body as { propagateFields?: unknown }).propagateFields)
      ? ((body as { propagateFields: unknown[] }).propagateFields as unknown[]).map(String)
      : [];
    const targets = Array.isArray((body as { propagateTo?: unknown }).propagateTo)
      ? ((body as { propagateTo: unknown[] }).propagateTo as unknown[]).map(String)
      : [];

    if (wanted.length && targets.length) {
      const fields = wanted.filter(isIdentityField);
      // The QID BEFORE this save is what identifies the person's other files;
      // if the QID itself was corrected, the siblings are the ones that still
      // carry the old one.
      const priorQid = String((body as { priorQid?: unknown }).priorQid ?? '').trim() || qid;

      const { data: siblings } = await supabase
        .from('paylater_customers')
        .select('id')
        .eq('company_id', ctx.companyId)
        .eq('qid', priorQid)
        .in('id', targets.slice(0, 50));

      const ids = (siblings ?? []).map((r) => r.id as string).filter((x) => x !== customerId);

      if (fields.length && ids.length) {
        const copy: Record<string, unknown> = {};
        for (const f of fields) copy[IDENTITY_FIELDS[f]] = row[IDENTITY_FIELDS[f]];

        /*
          Copying a gender can COMPLETE the file it lands on, so the stored
          flag has to be re-decided for each target rather than left as it was.
          The counts no longer read this flag, but the search screen's chip
          does, and a record that says "incomplete" about itself while every
          field is present is its own small lie.
        */
        if (fields.includes('gender')) {
          const { data: targets } = await supabase
            .from('paylater_customers')
            .select('id, gender, report_date, paylater_reg_date, paylater_orders(count)')
            .in('id', ids);
          for (const tRow of targets ?? []) {
            const o = (tRow as { paylater_orders?: { count: number }[] }).paylater_orders;
            const done = isCustomerCompleteFromParts({
              gender: (copy.gender as string | null) ?? (tRow.gender as string | null),
              reportDate: tRow.report_date as string | null,
              paylaterRegDate: tRow.paylater_reg_date as string | null,
              orderCount: o?.[0]?.count ?? 0,
            });
            await supabase
              .from('paylater_customers')
              .update({ is_complete: done })
              .eq('id', tRow.id as string);
          }
        }

        const { error: pErr } = await supabase
          .from('paylater_customers')
          .update(copy)
          .in('id', ids)
          .eq('company_id', ctx.companyId);
        if (pErr) throw pErr;

        await supabase.from('paylater_history').insert(
          ids.map((sid) => ({
            customer_id: sid,
            event: 'identity_copied',
            actor_id: ctx.pu.userId,
            detail: { fields, from: customerId },
          }))
        );
        propagated = ids.length;
      }
    }

    return NextResponse.json({ ok: true, id: customerId, complete, propagated });
  } catch (err) {
    console.error('PayLater save customer error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
