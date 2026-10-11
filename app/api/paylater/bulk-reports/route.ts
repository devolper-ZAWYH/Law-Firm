import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import { isCustomerComplete } from '@/lib/platform/paylaterIntake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/paylater/bulk-reports — apply a folder of customer reports at once.
 *
 * THE SHAPE OF THE PROBLEM. A month's batch arrives as one folder per customer,
 * each holding that customer's report PDF and a photograph of their ID card.
 * Opening a hundred files by hand to upload two documents each is the work this
 * removes. The BROWSER unzips and parses (the reports total ~59 MB, which no
 * serverless request will carry), and sends what it read here as data.
 *
 * MATCHING IS BY QID READ OUT OF THE REPORT ITSELF, not by the folder name. The
 * folder name is a label somebody typed; the QID inside the PDF is the document
 * the notice will be built from. They agreed on all 100 folders in the batch
 * this was built against, but when they disagree the document wins.
 *
 * A REPORT MAY BELONG TO A CUSTOMER IN ANOTHER BATCH. Five of a hundred did:
 * repeat customers whose file already lives in an earlier batch. Those are NOT
 * applied silently — they come back in `crossBatch` with the customer's details
 * so the person uploading can see who it is and decide. Only a QID listed in
 * `confirmed` is written. Nothing is ever moved between batches: the file stays
 * where its debt was recorded, or it is left alone.
 *
 * FILL EMPTY FIELDS ONLY, unless `overwrite` — v2's rule, because a value
 * somebody corrected by hand is usually the more trusted one.
 */

interface Extracted {
  qid: string | null;
  nameEn: string | null;
  nationality: string | null;
  email: string | null;
  mobile: string | null;
  paylaterRegDate: string | null;
  reportDate: string | null;
  debtTotal: number | null;
  currency: string | null;
  pendingInstalments: number;
  orders: {
    orderRef: string; orderDate: string | null; storeAr: string | null;
    storeEn: string | null; amount: number | null; instalment: number | null;
    paidCount: number | null; paidTotal: number | null; remaining: number | null;
  }[];
}

interface Item {
  qid: string;
  extracted: Extracted;
  /** The number on the customer's folder in the ZIP — "001- 2568… NAME". */
  fileNo?: string;
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
};

export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canEditFiles) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let body: {
    mode?: unknown; batchId?: unknown; items?: unknown;
    confirmed?: unknown; overwrite?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const commit = body.mode === 'commit';
  const batchId = String(body.batchId ?? '');
  const overwrite = body.overwrite === true;
  const items = Array.isArray(body.items) ? (body.items as Item[]) : [];
  const confirmed = new Set(
    Array.isArray(body.confirmed) ? (body.confirmed as unknown[]).map(String) : []
  );

  if (!batchId) {
    return NextResponse.json({ ok: false, error: 'Choose a batch.' }, { status: 400 });
  }
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: 'No reports were read.' }, { status: 400 });
  }
  if (items.length > 500) {
    return NextResponse.json({ ok: false, error: 'Too many reports at once.' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  try {
    const { data: batch } = await supabase
      .from('paylater_batches')
      .select('id, code')
      .eq('id', batchId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (!batch) {
      return NextResponse.json({ ok: false, error: 'No such batch.' }, { status: 404 });
    }

    // Every customer in the company, so a report can be matched wherever its
    // customer actually lives rather than only inside the chosen batch.
    const { data: all, error: aErr } = await supabase
      .from('paylater_customers')
      .select(
        'id, qid, batch_id, row_no, name_ar, name_en, nationality, outstanding, stage, bucket, gender, report_date, paylater_reg_date, currency, file_no_manual, paylater_batches(code)'
      )
      .eq('company_id', ctx.companyId);
    if (aErr) throw aErr;

    /*
      A QID CAN NAME MORE THAN ONE FILE, so the batch being imported into wins.

      Keeping the first row a company-wide select happened to return made the
      answer depend on row order: the same report could be reported as "in this
      batch" or "belongs to another batch" between two runs, and could be
      written to whichever copy came back first. Preferring the file in the
      chosen batch is both deterministic and what a person means — a report
      uploaded to E100 is about E100's file.
    */
    const byQid = new Map<string, Record<string, unknown>>();
    for (const c of all ?? []) {
      const q = String((c as { qid: string | null }).qid ?? '').trim();
      if (!q) continue;
      const held = byQid.get(q);
      if (!held || (c as { batch_id: string }).batch_id === batchId) {
        byQid.set(q, c as Record<string, unknown>);
      }
    }

    const codeOf = (c: Record<string, unknown>): string => {
      const rel = c.paylater_batches as { code: string } | { code: string }[] | null;
      return Array.isArray(rel) ? (rel[0]?.code ?? '') : (rel?.code ?? '');
    };

    // How many orders each customer already has, fetched ONCE. Asking per
    // customer turned a chunk into a round trip per file and was most of why a
    // full batch took two minutes.
    const orderCounts = new Map<string, number>();
    if (commit) {
      const { data: oc } = await supabase
        .from('paylater_orders')
        .select('customer_id');
      for (const o of oc ?? []) {
        const k = (o as { customer_id: string }).customer_id;
        orderCounts.set(k, (orderCounts.get(k) ?? 0) + 1);
      }
    }
    /** History rows are written once per chunk, not once per customer. */
    const historyRows: Record<string, unknown>[] = [];

    const inBatch: Record<string, unknown>[] = [];
    const crossBatch: Record<string, unknown>[] = [];
    const unmatched: string[] = [];
    let applied = 0;
    const kept: string[] = [];

    /** v2's fill-empty rule, applied to one customer. */
    const applyTo = async (cust: Record<string, unknown>, x: Extracted, fileNo?: string) => {
      const patch: Record<string, unknown> = {};
      const keptHere: string[] = [];
      const put = (col: string, current: unknown, next: unknown, label: string) => {
        if (next === null || next === undefined || next === '') return;
        const isEmpty = current === null || current === undefined || current === '';
        if (isEmpty || overwrite) patch[col] = next;
        else if (String(current) !== String(next)) keptHere.push(`${label}: ${current} ≠ ${next}`);
      };
      put('name_en', cust.name_en, str(x.nameEn), 'name');
      put('nationality', cust.nationality, str(x.nationality), 'nationality');
      put('email', cust.email, str(x.email), 'email');
      put('mobile', cust.mobile, str(x.mobile), 'mobile');
      put('paylater_reg_date', cust.paylater_reg_date, str(x.paylaterRegDate), 'registration date');
      put('report_date', cust.report_date, str(x.reportDate), 'report date');
      put('debt_total', cust.debt_total, x.debtTotal, 'total');
      // The report states its currency; a file keeps whatever it already had
      // unless it is the QAR default, in which case the report is better
      // evidence than the spreadsheet that never mentioned one.
      if (x.currency && /^[A-Z]{3}$/.test(x.currency) && cust.currency === 'QAR') {
        patch.currency = x.currency;
      }
      put('instalment_count', cust.instalment_count, x.pendingInstalments || null, 'instalments');

      /*
        THE FOLDER'S NUMBER IS THE FILE NUMBER. It is written on the physical
        file and used in the Progress Report, so it is a fact about the file
        rather than something to derive. Stored as the MANUAL number, which is
        exactly what that column is for: a number somebody assigned, which the
        automatic QID-order sequence then leaves alone.

        Zero-padded to three digits so "1" and "001" are one number, and only
        into an empty one — a number already set was set by a person.
      */
      if (fileNo && !cust.file_no_manual) {
        patch.file_no_manual = fileNo.padStart(3, '0');
      }

      const customerId = cust.id as string;

      // Orders are replaced wholesale when the report has any and the file has
      // none — a half-merged order list is not something anyone can check.
      const existingOrders = orderCounts.get(customerId) ?? 0;

      let wroteOrders = 0;
      if (x.orders?.length && (existingOrders === 0 || overwrite)) {
        await supabase.from('paylater_orders').delete().eq('customer_id', customerId);
        const { error: oErr } = await supabase.from('paylater_orders').insert(
          x.orders.map((o, i) => ({
            customer_id: customerId,
            order_ref: o.orderRef, order_date: o.orderDate,
            store_ar: o.storeAr, store_en: o.storeEn,
            amount: o.amount, instalment: o.instalment,
            paid_count: o.paidCount, paid_total: o.paidTotal,
            remaining: o.remaining, sort_index: i,
          }))
        );
        if (oErr) throw oErr;
        wroteOrders = x.orders.length;
      } else if (x.orders?.length) {
        keptHere.push(`orders: ${existingOrders} kept`);
      }

      // Completeness is recomputed from what the record will hold, never taken
      // from the client.
      patch.is_complete = isCustomerComplete({
        gender: (patch.gender ?? cust.gender ?? null) as string | null,
        reportDate: (patch.report_date ?? cust.report_date ?? null) as string | null,
        paylaterRegDate: (patch.paylater_reg_date ?? cust.paylater_reg_date ?? null) as string | null,
        orders: (wroteOrders ? x.orders : []).map((o) => ({
          orderRef: o.orderRef, orderDate: o.orderDate, storeAr: o.storeAr,
          amount: o.amount, instalment: o.instalment, paidCount: o.paidCount,
          paidTotal: o.paidTotal, remaining: o.remaining,
        })),
      });

      const { error: uErr } = await supabase
        .from('paylater_customers')
        .update(patch)
        .eq('id', customerId)
        .eq('company_id', ctx.companyId);
      if (uErr) throw uErr;

      historyRows.push({
        customer_id: customerId,
        event: 'report_read',
        actor_id: ctx.pu.userId,
        detail: { fields: Object.keys(patch).length, orders: wroteOrders, batch: batch.code },
      });

      applied++;
      kept.push(...keptHere.map((k) => `${cust.name_en ?? cust.qid}: ${k}`));
    };

    for (const it of items) {
      const q = String(it?.qid ?? '').trim();
      const cust = byQid.get(q);
      if (!cust) {
        unmatched.push(q);
        continue;
      }
      const sameBatch = cust.batch_id === batchId;
      const summary = {
        qid: q,
        customerId: cust.id,
        nameAr: cust.name_ar,
        nameEn: cust.name_en,
        batchCode: codeOf(cust),
        rowNo: cust.row_no,
        outstanding: cust.outstanding,
        stage: cust.stage,
        bucket: cust.bucket,
        nationality: cust.nationality,
        orders: it.extracted?.orders?.length ?? 0,
      };
      if (sameBatch) {
        inBatch.push(summary);
        if (commit) await applyTo(cust, it.extracted, it.fileNo);
      } else {
        crossBatch.push(summary);
        // ONLY on an explicit per-customer confirmation.
        if (commit && confirmed.has(q)) await applyTo(cust, it.extracted, it.fileNo);
      }
    }

    if (historyRows.length) {
      await supabase.from('paylater_history').insert(historyRows);
    }

    // Which customers in the chosen batch got nothing — so a partial folder
    // does not read as a finished one.
    const seen = new Set(items.map((i) => String(i?.qid ?? '').trim()));
    const missing = commit
      ? []
      : (all ?? [])
          .filter((c) => (c as { batch_id: string }).batch_id === batchId)
          .filter((c) => !seen.has(String((c as { qid: string | null }).qid ?? '').trim()))
          .map((c) => ({
            qid: (c as { qid: string | null }).qid,
            nameEn: (c as { name_en: string | null }).name_en,
            rowNo: (c as { row_no: number | null }).row_no,
          }));

    return NextResponse.json({
      ok: true,
      batchCode: batch.code,
      inBatch,
      crossBatch,
      unmatched,
      missing,
      applied: commit ? applied : 0,
      kept: kept.slice(0, 50),
    });
  } catch (err) {
    console.error('PayLater bulk reports error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
