import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolvePaylater } from '@/app/collections/guard';
import { parseWorkbook, type ParsedRow } from '@/lib/platform/paylaterExcel';
import { UnsafeSpreadsheetError } from '@/lib/platform/spreadsheetGuard';
import { isCustomerCompleteFromParts } from '@/lib/platform/paylaterIntake';
// paylaterTestMode — TEMPORARY, see lib/platform/paylaterTestMode.ts
import { PAYLATER_TEST_MODE } from '@/lib/platform/paylaterTestMode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Compressed upload cap. The bomb guard bounds what it may expand to. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/paylater/import — the month's Excel.
 *
 * TWO MODES, one route, because the preview and the write must agree about
 * what the file contains. `mode=preview` reports what WOULD happen and writes
 * nothing; `mode=commit` performs it. Parsing the file twice is cheap next to
 * the risk of a preview that describes a different reading than the import.
 *
 * DUPLICATES ARE SKIPPED BY QID, not overwritten — v2's rule, and it is
 * load-bearing: a customer already entered from his PDF carries order detail
 * the Excel does not have, so overwriting him with the thinner row would
 * DISCARD the richer record. Skipping keeps it.
 *
 * QID matching here is exact against the stored value. It does NOT apply the
 * trailing-zero widening that SEARCH does (see lib/platform/paylater.ts): a
 * search that casts wider only offers a person more rows to look at, while an
 * import that does it would silently merge two records on an inference the
 * firm has not confirmed.
 */
export async function POST(req: NextRequest) {
  const ctx = await resolvePaylater();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }
  if (!ctx.access.canLead) {
    return NextResponse.json({ ok: false, error: 'Not available to you.' }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const file = form.get('file');
  const batchId = String(form.get('batchId') ?? '');
  const mode = String(form.get('mode') ?? 'preview');

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'No file was uploaded.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'That file is larger than 5 MB.' },
      { status: 413 }
    );
  }
  if (!batchId) {
    return NextResponse.json({ ok: false, error: 'Choose a batch.' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  try {
    // The batch must belong to THIS company — a caller cannot import into
    // someone else's batch by supplying its id.
    const { data: batch, error: bErr } = await supabase
      .from('paylater_batches')
      .select('id, code, capacity')
      .eq('id', batchId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!batch) {
      return NextResponse.json({ ok: false, error: 'No such batch.' }, { status: 404 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let parsed;
    try {
      parsed = parseWorkbook(buffer);
    } catch (err) {
      if (err instanceof UnsafeSpreadsheetError) {
        return NextResponse.json(
          { ok: false, error: 'That file expands to an unsafe size and was refused.' },
          { status: 413 }
        );
      }
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : 'Could not read that file.',
        },
        { status: 400 }
      );
    }

    // Everything already in the COMPANY, not just this batch: v2 skips a
    // duplicate wherever it sits, and reports which batch holds it — a QID
    // arriving in September that is already in July's batch is the case that
    // matters most.
    const { data: existing, error: eErr } = await supabase
      .from('paylater_customers')
      .select('id, qid, batch_id, name_en, name_ar, mobile, email, nationality, instalment_count, debt_total, dpd, moi_check, notice_planned, case_reg_date, sheet_extra, paylater_batches(code)')
      .eq('company_id', ctx.companyId);
    if (eErr) throw eErr;

    const byQid = new Map<string, string>();
    /** The whole row, for the dates a repeat customer's file can still take. */
    const rowByQid = new Map<string, Record<string, unknown>>();
    /** QIDs already in the batch being imported into — the real duplicates. */
    const inThisBatch = new Set<string>();
    for (const r of existing ?? []) {
      const q = (r.qid as string | null)?.trim();
      if (!q) continue;
      const rel = r.paylater_batches as { code: string } | { code: string }[] | null;
      const code = Array.isArray(rel) ? rel[0]?.code : rel?.code;
      const here = r.batch_id === batchId;
      if (here) inThisBatch.add(q);
      // The file in the batch being imported into wins. Keeping whichever row
      // the database returned first made the dates land on an arbitrary one of
      // a repeat customer's files — the same non-determinism the report import
      // had, and just as invisible.
      if (!byQid.has(q) || here) {
        byQid.set(q, code ?? '');
        rowByQid.set(q, r as Record<string, unknown>);
      }
    }

    const withQid = parsed.rows.filter((r) => r.qid);

    /*
      A REPEAT CUSTOMER IS NOT A DUPLICATE FILE.

      v2 skipped any QID already in the store, and in a prototype holding one
      month of demo data that reads as "don't enter the same person twice". On
      the firm's real data it means something else: a customer who took a new
      loan in September and already had a July file is SKIPPED, and September's
      debt never enters the system at all. Repeat customers are ordinary — the
      person is the same, the debt is new, and each month's debt is its own
      file with its own claim, notice and case.

      So the test is now the BATCH, not the company. The same QID arriving
      twice into the SAME batch is a genuine duplicate — one month's sheet
      imported twice, or one debt entered twice — and is still skipped. The
      same QID in a different month is a new file, and the preview says whose
      other files it joins.
    */
    const repeats = withQid.filter(
      (r) => byQid.has(r.qid!.trim()) && !inThisBatch.has(r.qid!.trim())
    );
    const duplicates = withQid.filter((r) => inThisBatch.has(r.qid!.trim()));

    /*
      WHAT A SKIPPED ROW STILL CARRIES: EVERY FIELD IN THE SHEET.

      Skipping a row was throwing away a whole record's worth of information.
      The monthly workbook is the only place several of these are written down
      — the notice date and the case registration date are the Team Leader's
      schedule, the MOI residency check comes from nowhere else, and for a file
      imported from the enforcement export the sheet may be the only source of
      a mobile number or an email.

      EMPTY FIELDS ONLY. A value already on the file was put there by somebody
      working it, or read out of the customer's own report, and both know more
      than a spreadsheet row does. A re-import can therefore never undo work;
      it can only fill gaps.

      TWO FIELDS ARE NEVER TOUCHED. `qid` is what matched the row to the file,
      so writing it back is either a no-op or a way to break the match. `row_no`
      is the BATCH's numbering, and the sheet's own numbering belongs to the
      sheet — copying it across would collide with the numbers the batch
      already uses.
    */
    const SHEET_FIELDS: [keyof ParsedRow, string][] = [
      ['nameEn', 'name_en'],
      ['nameAr', 'name_ar'],
      ['mobile', 'mobile'],
      ['email', 'email'],
      ['nationality', 'nationality'],
      ['instalmentCount', 'instalment_count'],
      ['debtTotal', 'debt_total'],
      ['dpd', 'dpd'],
      ['moiCheck', 'moi_check'],
      ['noticePlanned', 'notice_planned'],
      ['caseRegDate', 'case_reg_date'],
    ];

    const dateFills = [...repeats, ...duplicates]
      .map((r) => {
        const cur = rowByQid.get(r.qid!.trim());
        if (!cur) return null;
        const patch: Record<string, unknown> = {};
        for (const [from, col] of SHEET_FIELDS) {
          const next = r[from];
          if (next === null || next === undefined || next === '') continue;
          const have = cur[col];
          if (have === null || have === undefined || have === '') patch[col] = next;
        }
        /*
          The unfamiliar columns merge rather than replace, and only where the
          file does not already carry that heading. Replacing would let a sheet
          that has dropped a column erase what an earlier one recorded.
        */
        const have = (cur.sheet_extra ?? {}) as Record<string, string>;
        const addedExtra: string[] = [];
        const merged = { ...have };
        for (const [k, v] of Object.entries(r.extra ?? {})) {
          if (!have[k] && v) {
            merged[k] = v;
            addedExtra.push(k);
          }
        }
        if (addedExtra.length) patch.sheet_extra = merged;

        return Object.keys(patch).length
          ? {
              id: cur.id as string,
              patch,
              fields: [...Object.keys(patch).filter((f) => f !== 'sheet_extra'), ...addedExtra],
            }
          : null;
      })
      .filter(Boolean) as { id: string; patch: Record<string, unknown>; fields: string[] }[];

    // paylaterTestMode — TEMPORARY. Ticked in the dialog, this imports the
    // duplicates as new files in the chosen batch, so the one spreadsheet the
    // firm has can be used to rehearse an import it has already performed.
    // Admins only, only while the flag is on, and never the default.
    const allowDuplicates =
      PAYLATER_TEST_MODE &&
      ctx.pu.isAdmin &&
      String(form.get('allowDuplicates') ?? '') === '1';

    const fresh = allowDuplicates
      ? withQid
      : withQid.filter((r) => !inThisBatch.has(r.qid!.trim()));

    const { count: currentCount } = await supabase
      .from('paylater_customers')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId)
      .eq('batch_id', batchId);

    const wouldTotal = (currentCount ?? 0) + fresh.length;
    const overCapacity =
      batch.capacity !== null && wouldTotal > (batch.capacity as number);

    const summary = {
      batchCode: batch.code as string,
      totalRows: parsed.totalRows,
      newCount: fresh.length,
      duplicateCount: duplicates.length,
      /** Same person, different month — imported, not skipped. */
      repeatCount: repeats.length,
      repeatSample: repeats.slice(0, 5).map((r) => ({
        qid: r.qid,
        nameEn: r.nameEn,
        inBatch: byQid.get(r.qid!.trim()) ?? '',
      })),
      /** Existing files this sheet can still fill a gap on. */
      dateFillCount: dateFills.length,
      // paylaterTestMode — TEMPORARY
      allowDuplicates,
      testMode: PAYLATER_TEST_MODE && ctx.pu.isAdmin,
      noQidCount: parsed.noQidCount,
      ignoredColumns: parsed.ignoredColumns,
      missingColumns: parsed.missingColumns,
      overCapacity,
      capacity: batch.capacity as number | null,
      wouldTotal,
      duplicateSample: duplicates.slice(0, 5).map((r) => ({
        qid: r.qid,
        nameEn: r.nameEn,
        inBatch: byQid.get(r.qid!.trim()) ?? '',
      })),
      sample: fresh.slice(0, 5),
    };

    if (mode !== 'commit') {
      return NextResponse.json({ ok: true, preview: summary });
    }

    // Applied before the inserts, and NOT optional: a sheet that is all
    // duplicates — which a re-import of an already-imported month is — would
    // otherwise do nothing at all, while carrying the only copy of the two
    // dates the files are missing. Empty dates only, so a date somebody
    // working the file has already set is never overwritten.
    let datesFilled = 0;
    if (dateFills.length) {
      for (const f of dateFills) {
        const { error } = await supabase
          .from('paylater_customers')
          .update(f.patch)
          .eq('id', f.id)
          .eq('company_id', ctx.companyId);
        if (error) throw error;
      }
      /*
        Filling a gap can COMPLETE a file — a missing report date was often the
        only thing outstanding — so the stored flag is re-decided for each one
        rather than left saying "incomplete" about a record that no longer is.
      */
      const { data: touched } = await supabase
        .from('paylater_customers')
        .select('id, gender, report_date, paylater_reg_date, paylater_orders(count)')
        .in('id', dateFills.map((f) => f.id));
      for (const tRow of touched ?? []) {
        const o = (tRow as { paylater_orders?: { count: number }[] }).paylater_orders;
        await supabase
          .from('paylater_customers')
          .update({
            is_complete: isCustomerCompleteFromParts({
              gender: tRow.gender as string | null,
              reportDate: tRow.report_date as string | null,
              paylaterRegDate: tRow.paylater_reg_date as string | null,
              orderCount: o?.[0]?.count ?? 0,
            }),
          })
          .eq('id', tRow.id as string);
      }

      await supabase.from('paylater_history').insert(
        dateFills.map((f) => ({
          customer_id: f.id,
          event: 'filled_from_sheet',
          actor_id: ctx.pu.userId,
          actor_label: 'import:excel',
          detail: { file: file.name, fields: f.fields },
        }))
      );
      datesFilled = dateFills.length;
    }

    if (fresh.length === 0) {
      return NextResponse.json({ ok: true, imported: 0, datesFilled, preview: summary });
    }

    // Row numbers continue from the batch's highest, so an import into a batch
    // that already holds files does not restart at 1 and collide.
    const { data: maxRow } = await supabase
      .from('paylater_customers')
      .select('row_no')
      .eq('company_id', ctx.companyId)
      .eq('batch_id', batchId)
      .order('row_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    let nextRow = ((maxRow?.row_no as number | undefined) ?? 0) + 1;

    const toInsert = fresh.map((r: ParsedRow) => ({
      company_id: ctx.companyId,
      batch_id: batchId,
      // paylaterTestMode: a duplicate carries the row number it already has in
      // its own batch, so a rehearsal import must number from the end instead.
      row_no: allowDuplicates ? nextRow++ : (r.rowNo ?? nextRow++),
      name_en: r.nameEn,
      name_ar: r.nameAr,
      qid: r.qid,
      qid_normalized: r.qid,
      nationality: r.nationality,
      mobile: r.mobile,
      email: r.email,
      instalment_count: r.instalmentCount,
      debt_total: r.debtTotal,
      dpd: r.dpd,
      moi_check: r.moiCheck,
      sheet_extra: r.extra,
      notice_planned: r.noticePlanned,
      case_reg_date: r.caseRegDate,
      // Excel-imported customers start incomplete BY DEFINITION — the order
      // detail completeness requires exists only in the PDF reports.
      is_complete: false,
      stage: 'notice_planned',
      source_row: r as unknown as Record<string, unknown>,
      created_by: ctx.pu.userId,
    }));

    const { data: inserted, error: iErr } = await supabase
      .from('paylater_customers')
      .insert(toInsert)
      .select('id');
    if (iErr) throw iErr;

    const events = (inserted ?? []).map((d) => ({
      customer_id: d.id as string,
      event: 'imported',
      stage_to: 'notice_planned',
      actor_id: ctx.pu.userId,
      actor_label: 'import:excel',
      detail: { file: file.name, batch: batch.code },
    }));
    if (events.length) await supabase.from('paylater_history').insert(events);

    return NextResponse.json({
      ok: true,
      imported: inserted?.length ?? 0,
      datesFilled,
      preview: summary,
    });
  } catch (err) {
    console.error('PayLater import error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
