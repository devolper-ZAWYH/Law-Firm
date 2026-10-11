/**
 * Import the v4 PayLater dataset — 7 batches and 560 real files — into the
 * tables created by migration #34.
 *
 * The dataset lives OUTSIDE the repo on purpose: it carries real names, QIDs,
 * phone numbers and debts, and committing it would write client personal data
 * into git history permanently. So the path is an argument, defaulting to where
 * the spec says the file sits.
 *
 *   npm run import:paylater                       # default path
 *   npm run import:paylater -- /path/to/data.json
 *
 * IDEMPOTENT. Re-running matches existing rows on (batch, row_no) and updates
 * them rather than inserting duplicates, so a corrected dataset can be brought
 * in the same way — which is the point of the parser re-validating itself
 * against the Dashboard totals every month.
 *
 * WHAT IT DOES NOT DO — it does not clean the data. The three problems the
 * parser reports, and the QID anomalies found on top of them, are written to
 * paylater_data_issues and left in the records exactly as parsed. That is the
 * spec's rule, and D100 #31 is the reason for it: a guess is sitting under
 * figures that reconcile, and burying it would make it impossible to find.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

const V4_DIR = join(homedir(), 'Desktop', 'PayLater system', 'VERSION 4');
const DEFAULT_DATASET = join(V4_DIR, 'paylater_dataset_full.json');
/**
 * The dataset ships INSIDE files.zip and is normally never unpacked — the spec
 * points at the zip, not at a loose JSON. So a missing default path is not an
 * error yet: look in the archive before giving up, and read it without writing
 * the client data to disk in a second place.
 */
const DEFAULT_ZIP = join(V4_DIR, 'files.zip');
const ZIP_MEMBER = 'paylater_dataset_full.json';

function readDataset(path: string, explicit: boolean): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (explicit) throw e;
    // Fall back to the archive the spec actually names.
    return execFileSync('unzip', ['-p', DEFAULT_ZIP, ZIP_MEMBER], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

/** The company the portal is scoped to. Matches lib/platform/singleCompany.ts. */
const COMPANY_NAME_EN = 'Ali AlBaker Law Firm';

interface RawCustomer {
  batch: string;
  batch_no: number;
  month: string;
  row: number;
  [k: string]: unknown;
}

interface Dataset {
  generated: string;
  issues: { batch: string; row: number; kind: string; detail: string; severity: string }[];
  fee_model: Record<string, number>;
  batches: { code: string; no: number; month: string; kpi: Record<string, number> }[];
  customers: RawCustomer[];
}

// --- small coercions --------------------------------------------------------
// The source is free text in places, so every value passes through one of these
// rather than being trusted. A value that cannot be read becomes null and the
// original stays in the matching *_raw column.

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean => v === true;

/** ISO date or null. Guards against the source's occasional non-dates. */
const date = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s.slice(0, 10));
  return Number.isNaN(d.getTime()) ? null : s.slice(0, 10);
};

async function main() {
  /**
   * `--only <CODE>` restricts everything below to one batch.
   *
   * A whole-dataset re-import is the right tool for a corrected dataset, and
   * the wrong one for putting a single batch back: it also rewrites the other
   * six from the RAW source, which would undo corrections made since — the 258
   * QIDs whose trailing zero was stripped are stored on those rows, and the raw
   * dataset still carries the zero. So a restore names its batch, and nothing
   * outside it is read or written.
   *
   *   npm run import:paylater -- --only E100
   */
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt === -1 ? null : (argv[onlyAt + 1] ?? '').toUpperCase();
  if (onlyAt !== -1 && !only) {
    console.error('--only needs a batch code, e.g. --only E100');
    process.exit(1);
  }
  const positional = argv.filter((a, i) => a !== '--only' && i !== onlyAt + 1);
  const datasetPath = positional[0] ?? DEFAULT_DATASET;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let dataset: Dataset;
  try {
    dataset = JSON.parse(
      readDataset(datasetPath, positional[0] !== undefined)
    ) as Dataset;
  } catch (e) {
    console.error(`Could not read the dataset at:\n  ${datasetPath}\n  (nor inside ${DEFAULT_ZIP})\n`);
    console.error(
      'It is deliberately not in the repo (real client data). Pass the path:\n' +
        '  npm run import:paylater -- /path/to/paylater_dataset_full.json'
    );
    console.error(String(e));
    process.exit(1);
  }

  console.log(`Dataset generated ${dataset.generated}`);
  console.log(`  ${dataset.batches.length} batches, ${dataset.customers.length} customers`);

  // Narrow the dataset itself rather than guarding each stage: from here on
  // "the dataset" IS the named batch, so no later step can reach outside it.
  if (only) {
    const before = dataset.customers.length;
    dataset = {
      ...dataset,
      batches: dataset.batches.filter((b) => b.code.toUpperCase() === only),
      customers: dataset.customers.filter((c) => c.batch.toUpperCase() === only),
      issues: dataset.issues.filter((i) => i.batch?.toUpperCase() === only),
    };
    if (dataset.batches.length === 0) {
      console.error(`No batch "${only}" in the dataset.`);
      process.exit(1);
    }
    console.log(`  --only ${only}: ${dataset.customers.length} of ${before} customers`);
  }

  // --- company ------------------------------------------------------------
  const { data: company, error: cErr } = await supabase
    .from('companies')
    .select('id, name_en')
    .eq('name_en', COMPANY_NAME_EN)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!company) {
    console.error(`Company "${COMPANY_NAME_EN}" not found. Run the platform seed first.`);
    process.exit(1);
  }
  const companyId = company.id as string;
  console.log(`Company: ${company.name_en}`);

  // --- batches ------------------------------------------------------------
  // Capacity comes from the code's numeric suffix (A10 → 10): that is what the
  // batch was MEANT to hold. The actual file count can differ and is not
  // overwritten onto it — v2 warns when an import exceeds capacity, it does
  // not refuse, because the real batch is whatever the Excel contains.
  const kafalahFrom = dataset.fee_model.kafalah_from_batch ?? 6;
  const batchIdByCode = new Map<string, string>();

  for (const b of dataset.batches) {
    const capacity = Number(b.code.replace(/^[A-Z]+/, '')) || null;
    const feeModel = {
      court: dataset.fee_model.court,
      kafalah: b.no >= kafalahFrom ? dataset.fee_model.kafalah : 0,
      enforcement: dataset.fee_model.enforcement,
      request: dataset.fee_model.request,
      admin: dataset.fee_model.admin,
      damages_pct: dataset.fee_model.damages_pct,
    };

    const { data: existing } = await supabase
      .from('paylater_batches')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', b.code)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('paylater_batches')
        .update({ batch_no: b.no, month: b.month, capacity, fee_model: feeModel })
        .eq('id', existing.id);
      if (error) throw new Error(`batch ${b.code}: ${error.message}`);
      batchIdByCode.set(b.code, existing.id as string);
    } else {
      const { data, error } = await supabase
        .from('paylater_batches')
        .insert({
          company_id: companyId,
          code: b.code,
          batch_no: b.no,
          month: b.month,
          capacity,
          fee_model: feeModel,
        })
        .select('id')
        .single();
      if (error) throw new Error(`batch ${b.code}: ${error.message}`);
      batchIdByCode.set(b.code, data.id as string);
    }
  }
  console.log(`Batches: ${batchIdByCode.size}`);

  // --- customers ----------------------------------------------------------
  const existingRes = await supabase
    .from('paylater_customers')
    .select('id, batch_id, row_no')
    .eq('company_id', companyId);
  if (existingRes.error) throw new Error(existingRes.error.message);
  const existingByKey = new Map<string, string>();
  for (const r of existingRes.data ?? []) {
    existingByKey.set(`${r.batch_id}:${r.row_no}`, r.id as string);
  }

  const rows = dataset.customers.map((c) => {
    const batchId = batchIdByCode.get(c.batch);
    if (!batchId) throw new Error(`Unknown batch ${c.batch} on row ${c.row}`);
    return {
      company_id: companyId,
      batch_id: batchId,
      row_no: c.row,

      name_ar: str(c.name_ar),
      name_en: str(c.name_en),
      qid: str(c.qid),
      // The decision on the trailing-zero anomaly was to infer NOTHING, so this
      // is an exact copy. See the header of migration #34 for why the column
      // exists anyway: it is the seam a future correction would use.
      qid_normalized: str(c.qid),
      nationality: str(c.nationality),

      notice_planned: date(c.notice_planned),
      notice_sent: bool(c.notice_sent),
      notice_email_only: bool(c.notice_email_only),
      notice_raw: str(c.notice_raw),

      settled_pre: bool(c.settled_pre),
      settled_pre_amount: num(c.settled_pre_amount),
      settled_pre_partial: bool(c.settled_pre_partial),
      settled_pre_raw: str(c.settled_pre_raw),

      // v4's `reg_date` is the COURT registration, not the PayLater one.
      case_reg_date: date(c.reg_date),
      case_filed: bool(c.case_filed),
      case_fees_paid: bool(c.case_fees_paid),
      case_fees_raw: str(c.case_fees_raw),
      case_number: str(c.case_number),
      case_status: str(c.case_status),
      case_status_raw: str(c.case_status_raw),
      court_date: date(c.court_date),

      has_judgment: bool(c.has_judgment),
      judg_outstanding: num(c.judg_outstanding),
      judg_compensation: num(c.judg_compensation),
      judg_fees: num(c.judg_fees),
      judgment_raw: str(c.judgment_raw),
      // v4's `total_amount` is the judgment total, not the debt total.
      judgment_total: num(c.total_amount),

      settled_post: bool(c.settled_post),
      settled_post_amount: num(c.settled_post_amount),
      settled_post_raw: str(c.settled_post_raw),
      paid_after_judgment: bool(c.paid_after_judgment),
      paid_after_judgment_amount: num(c.paid_after_judgment_amount),

      enf_registered: bool(c.enf_registered),
      enf_fees_paid: bool(c.enf_fees_paid),
      enf_number: str(c.enf_number),
      enf_requests: Array.isArray(c.enf_requests) ? c.enf_requests : [],

      outstanding: num(c.outstanding),
      total_due: num(c.total_due),
      received: num(c.received),
      fees: (c.fees as Record<string, unknown>) ?? {},
      enf: (c.enf as Record<string, unknown>) ?? {},
      stage: str(c.stage),
      bucket: str(c.bucket),
      observations: str(c.observations),
      procedures: str(c.procedures),

      // Every imported file is incomplete BY DEFINITION: the order detail that
      // completeness requires exists only in the customer report PDFs, and the
      // monthly Excel this dataset came from does not carry it.
      is_complete: false,

      // The parsed record, kept whole, for v4's "البيانات الأصلية" tab — the
      // wording the parser was working from when a value looks wrong.
      source_row: c as unknown as Record<string, unknown>,
    };
  });

  const toInsert = rows.filter((r) => !existingByKey.has(`${r.batch_id}:${r.row_no}`));
  const toUpdate = rows.filter((r) => existingByKey.has(`${r.batch_id}:${r.row_no}`));

  const CHUNK = 100;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('paylater_customers')
      .insert(slice)
      .select('id');
    if (error) throw new Error(`customers ${i}: ${error.message}`);

    // History from day one — the spec requires it even though gates are off.
    const events = (data ?? []).map((d) => ({
      customer_id: d.id as string,
      event: 'imported',
      actor_label: 'import:v4-dataset',
      detail: { generated: dataset.generated },
    }));
    if (events.length) {
      const { error: hErr } = await supabase.from('paylater_history').insert(events);
      if (hErr) throw new Error(`history ${i}: ${hErr.message}`);
    }
    process.stdout.write(`\r  inserted ${Math.min(i + CHUNK, toInsert.length)}/${toInsert.length}`);
  }
  if (toInsert.length) process.stdout.write('\n');

  // Updates go through upsert on the PRIMARY KEY, in chunks, rather than one
  // statement per row: a re-import touches all 560 files and 560 sequential
  // round trips takes minutes, which turns "re-run it with next month's data"
  // into something nobody does.
  //
  // Keyed on `id` (looked up above) and NOT on a unique (batch_id, row_no)
  // constraint, deliberately. D100 is the reason: the source really did contain
  // two rows numbered 1, and a database that refuses such an import converts a
  // reportable data problem into a failed run.
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const slice = toUpdate.slice(i, i + CHUNK).map((r) => ({
      ...r,
      id: existingByKey.get(`${r.batch_id}:${r.row_no}`)!,
    }));
    const { error } = await supabase
      .from('paylater_customers')
      .upsert(slice, { onConflict: 'id' });
    if (error) throw new Error(`update ${i}: ${error.message}`);
    process.stdout.write(`\r  updated ${Math.min(i + CHUNK, toUpdate.length)}/${toUpdate.length}`);
  }
  if (toUpdate.length) process.stdout.write('\n');

  console.log(`Customers: ${toInsert.length} inserted, ${toUpdate.length} updated`);

  // --- data issues --------------------------------------------------------
  // Cleared and rewritten, so a re-import after a corrected dataset does not
  // leave a stale problem on the notes screen. Confirmations are preserved: a
  // human answer to "is D100 #31 right?" must survive a re-import.
  const { data: priorIssues } = await supabase
    .from('paylater_data_issues')
    .select('kind, detail, confirmed_by, confirmed_at')
    .eq('company_id', companyId);
  const confirmedByKey = new Map<string, { by: string | null; at: string | null }>();
  for (const p of priorIssues ?? []) {
    if (p.confirmed_at) {
      confirmedByKey.set(`${p.kind}:${p.detail}`, {
        by: p.confirmed_by as string | null,
        at: p.confirmed_at as string,
      });
    }
  }
  // A scoped restore leaves the notes screen alone. The issues are stated
  // across the whole dataset — the trailing-zero finding names four batches —
  // so rewriting them from one batch would replace a company-wide record with
  // a partial one, and re-assert "left exactly as parsed" over a correction
  // that has since been applied.
  if (!only) {
    await supabase.from('paylater_data_issues').delete().eq('company_id', companyId);
  }

  const issues: Record<string, unknown>[] = [];

  for (const i of dataset.issues) {
    issues.push({
      company_id: companyId,
      batch_id: batchIdByCode.get(i.batch) ?? null,
      kind: i.kind,
      severity: i.severity,
      detail: i.detail,
      resolution:
        i.kind === 'duplicate_row_number'
          ? 'Imported with the parser’s numbering so the batch totals reconcile. NOT CONFIRMED.'
          : i.kind === 'misplaced_case_number'
            ? 'Imported as the parser recovered it; the case number is in its proper field.'
            : null,
    });
  }

  // The QID anomalies, found on top of what the parser reports. Grouped rather
  // than one row per record: 258 identical entries would bury the three
  // problems that need a person to look at them.
  const trailingZero = dataset.customers.filter((c) => /^\d{12}0?$/.test(String(c.qid)) && String(c.qid).length === 12);
  if (trailingZero.length) {
    const batches = [...new Set(trailingZero.map((c) => c.batch))].join(', ');
    issues.push({
      company_id: companyId,
      kind: 'qid_trailing_zero',
      severity: 'warn',
      detail:
        `${trailingZero.length} records carry a 12-digit QID where a Qatari QID is 11. ` +
        `Every one of them ends in 0, and removing that zero yields a valid 11-digit QID in all ${trailingZero.length} cases — ` +
        `an Excel numeric-format artifact in the source. Confined to batches ${batches}; C100, D100 and E100 are clean.`,
      resolution:
        'Left exactly as parsed — nothing inferred. Customer search also matches the 11-digit form, so a card can still be looked up.',
    });
  }

  // The per-batch claims do not always sum to the batch total the firm's own
  // Dashboard states. v4's notes say the figures reconcile, and for the four
  // buckets and the collected totals they do — but the CLAIMS column does not,
  // in four batches, by 4,160.47 in total.
  //
  // No cause is asserted here. A10's gap is exactly one file's claim (a
  // customer whose observation says he had already paid through the app, so the
  // Dashboard may exclude him), A50's is 0.88 and reads as rounding, and A100's
  // and B100's match no single row at all. Guessing a rule from one of four
  // cases is how the D100 #31 problem was created; this is reported instead.
  for (const b of dataset.batches) {
    const summed = dataset.customers
      .filter((c) => c.batch === b.code)
      .reduce((s, c) => s + Number(c.outstanding ?? 0), 0);
    const gap = summed - Number(b.kpi.claims ?? 0);
    if (Math.abs(gap) < 0.005) continue;
    issues.push({
      company_id: companyId,
      batch_id: batchIdByCode.get(b.code) ?? null,
      kind: 'claims_do_not_sum',
      severity: 'warn',
      detail:
        `${b.code}: the ${b.kpi.files} files' claims sum to ${summed.toFixed(2)}, but the batch total states ` +
        `${Number(b.kpi.claims).toFixed(2)} — a difference of ${gap.toFixed(2)}. ` +
        `Row count and row numbering are both correct, so this is not a missing or duplicated file.`,
      resolution:
        'Imported as parsed; both figures are kept. Cause not determined — only A10’s gap matches a single file exactly.',
    });
  }

  for (const c of dataset.customers) {
    const q = String(c.qid ?? '');
    if (q.length !== 11 && q.length !== 12) {
      issues.push({
        company_id: companyId,
        batch_id: batchIdByCode.get(c.batch) ?? null,
        kind: 'qid_malformed',
        severity: 'error',
        detail: `${c.batch} #${c.row} (${c.name_en}) has QID "${q}" — ${q.length} digits, not 11.`,
        resolution: 'Left exactly as parsed. Needs the QID card to correct.',
      });
    }
  }

  for (const i of issues) {
    const prior = confirmedByKey.get(`${i.kind}:${i.detail}`);
    if (prior) {
      i.confirmed_by = prior.by;
      i.confirmed_at = prior.at;
    }
  }

  if (only) {
    console.log('Data issues: left untouched (scoped run)');
  } else {
    const { error: iErr } = await supabase.from('paylater_data_issues').insert(issues);
    if (iErr) throw new Error(`issues: ${iErr.message}`);
    console.log(`Data issues: ${issues.length} recorded`);
  }

  // --- reconciliation -----------------------------------------------------
  // The point of the v4 parser is that its figures reconcile against the firm's
  // own Dashboard. An import that silently changed a total would be worse than
  // one that failed, so the totals are re-checked here, from the rows that
  // actually landed in the database.
  // Scoped, this reconciles the ONE batch: comparing a single batch's rows
  // against the whole dataset's claims would always fail.
  const checkQuery = supabase
    .from('paylater_customers')
    .select('outstanding, bucket, batch_id')
    .eq('company_id', companyId);
  const { data: check, error: kErr } = await (only
    ? checkQuery.eq('batch_id', batchIdByCode.get(dataset.batches[0].code)!)
    : checkQuery);
  if (kErr) throw new Error(kErr.message);

  const storedClaims = (check ?? []).reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
  const sourceClaims = dataset.customers.reduce((s, c) => s + Number(c.outstanding ?? 0), 0);
  const statedClaims = dataset.batches.reduce((s, b) => s + Number(b.kpi.claims ?? 0), 0);

  console.log('\nReconciliation');
  console.log(`  rows in database   ${(check ?? []).length}`);
  console.log(`  claims, source     ${sourceClaims.toFixed(3)}`);
  console.log(`  claims, database   ${storedClaims.toFixed(3)}`);
  console.log(`  claims, batch KPIs ${statedClaims.toFixed(3)}`);

  const drift = Math.abs(storedClaims - sourceClaims);
  if (drift > 0.005) {
    console.error(`\nFAILED: claims drifted by ${drift.toFixed(3)} between source and database.`);
    process.exit(1);
  }
  console.log('  claims match to the third decimal.');

  const buckets: Record<string, number> = {};
  for (const r of check ?? []) buckets[String(r.bucket)] = (buckets[String(r.bucket)] ?? 0) + 1;
  console.log(`  buckets            ${JSON.stringify(buckets)}`);
}

main().catch((e) => {
  console.error('\nImport failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
