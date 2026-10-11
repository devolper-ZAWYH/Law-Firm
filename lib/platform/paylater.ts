/**
 * PAYLATER — access rules and the data layer for the second portal.
 *
 * The portal is scoped to ONE company (Ali AlBaker Law Firm). Everything here
 * takes a companyId and filters on it; nothing reads across companies.
 *
 * WHO REACHES IT — three ways in, and the first two need no grant:
 *
 *   • a global admin,
 *   • a manager of the company,
 *   • anyone holding ANY ONE of the four PayLater roles.
 *
 * That mirrors how the rest of the platform already works (see reachesAdmin in
 * auth.ts) and is why there is no 'paylater.access' capability key: it would be
 * a key that is true for people who were never granted it, which is exactly the
 * kind of half-truth that makes a permission audit unreliable. Access is
 * COMPUTED here, in one function, and the four role keys stay flat — see the
 * long note above PAYLATER_ROLE_KEYS in capabilities.ts.
 *
 * DEPLOY SAFETY. New code reaches production before migration #34 runs, so
 * every read below tolerates the tables not existing yet and returns an empty
 * result instead of throwing — the same probe-and-latch contract as files.ts
 * and tasks.ts. A PayLater screen on an un-migrated deploy is empty, not a 500.
 */

import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { isMissingRelationError } from '@/lib/platform/schemaCompat';
import { toPaylaterRole, type PaylaterRole } from '@/lib/platform/paylaterRoles';
import { missingIntakeParts } from '@/lib/platform/paylaterIntake';
import {
  canAdmin,
  isManagerOfCompany,
  type PlatformUser,
} from '@/lib/platform/auth';

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface PaylaterAccess {
  /** May this person open the portal at all? */
  canOpen: boolean;
  /**
   * The ONE PayLater role they hold, or null.
   *
   * Singular, not a list. These are mutually exclusive jobs — the Lawyer signs
   * the notice and the Auditor checks it — so a person holding two would turn
   * a review into a self-review. It is stored as a single column
   * (memberships.paylater_role, #35) precisely so two cannot be represented.
   * Null for an admin or manager who was never given one.
   */
  role: PaylaterRole | null;
  /** Reached by platform role rather than by an assigned PayLater role. */
  byRole: boolean;
  /**
   * May divide batches, assign notice dates, review the final notice, override.
   * True for Team Leaders AND for anyone who is here by role: the spec puts
   * managers and admins alongside Team Leaders for override.
   */
  canLead: boolean;
  /**
   * May create and edit customer FILES — the intake work.
   *
   * The Employee and the Team Leader do this; the LAWYER AND THE AUDITOR DO
   * NOT. The journey is specific about what those two are for: the lawyer
   * stamps and signs the notice (¶37–38) and the auditor audits and prints the
   * legal memo (¶43–45). Neither does data entry, and the gates spec has them
   * closing two different steps on the same file — 2.3 and 2.5 — precisely so
   * that two people have looked at it.
   *
   * Letting them edit intake would not just be an unused power: it would let
   * the person who signs a notice also change the debt it is claiming, which is
   * the separation those two steps exist to create.
   */
  canEditFiles: boolean;
  /**
   * May REMOVE a customer file.
   *
   * Whoever may prepare a file may remove one, PLUS an admin unconditionally.
   * canEditFiles subtracts for an assigned lawyer or auditor on purpose — the
   * person who signs a notice must not be able to change the debt it claims —
   * but that separation is about editing figures, and it was catching the
   * admin, who could then not remove a file at all.
   */
  canDeleteFiles: boolean;
}

const NO_ACCESS: PaylaterAccess = {
  canOpen: false,
  role: null,
  byRole: false,
  canLead: false,
  canEditFiles: false,
  canDeleteFiles: false,
};

/**
 * Resolve what this person may do in the PayLater portal for one company.
 *
 * Returns a closed answer rather than a boolean so callers do not each
 * re-derive "…and are they a Team Leader?" from the raw grant list.
 */
export async function paylaterAccess(
  pu: PlatformUser,
  companyId: string
): Promise<PaylaterAccess> {
  const byRole = canAdmin(pu) || isManagerOfCompany(pu, companyId);

  const membership = pu.memberships.find((m) => m.companyId === companyId);

  /*
    NO QUERY. The role arrives on the membership, read as part of the single
    query that resolves the caller's identity — see membershipRows in
    lib/platform/auth.ts.

    This used to be its own `memberships` select, awaited AFTER the identity
    query that had just read the very same table. On a database in another
    region that is a full extra round trip on every PayLater page load, for one
    string; it was most of why PayLater cost roughly double what the main portal
    cost per navigation.

    `undefined` means migration #35 has not run, so the column could not be
    read. That is NOT the same as "no role assigned", and it must not grant
    anything: a read that could not prove access must never hand it out. An
    admin or manager still gets in on `byRole`, which needs no column at all —
    which is exactly the degraded behaviour the old catch block provided.
  */
  const role =
    membership?.paylaterRole === undefined
      ? null
      : toPaylaterRole(membership.paylaterRole);

  if (!byRole && !role) return NO_ACCESS;

  /*
    AN ASSIGNED LAWYER OR AUDITOR ROLE SUBTRACTS, AND IT OUTRANKS THE PLATFORM ROLE.

    `byRole` is computed from the platform role — admin, or manager of this
    company — and it used to be a pure ADD: `canEditFiles: byRole || …`. So a
    lawyer who also held a manager membership got edit rights on intake, and
    every intake route admitted them.

    That defeats the whole reason this is a single-valued column. Gates 2.3 and
    2.5 put the lawyer and the auditor on the same file as checks on each
    other's work; a lawyer who can change the debt is signing a notice for a
    figure they set themselves. PayLater is single-company, so "the firm's
    lawyer is also a manager" is the ORDINARY case here, not an edge one.

    Assigning someone `lawyer` or `auditor` is a deliberate statement of which
    PayLater job they do. It therefore wins over the platform default: if you
    want a person to prepare files, do not also make them the lawyer who signs
    for them.

    Both rules subtract, per the journey's own table (CLAUDE.md) — a Lawyer or
    Auditor divides no batch and prepares no file. `canOpen` is untouched: all
    four roles read, which is what lets them do their checking.
  */
  const isChecker = role === 'lawyer' || role === 'auditor';

  const canEditFiles =
    !isChecker && (byRole || role === 'team_leader' || role === 'employee');

  return {
    canOpen: true,
    role,
    byRole,
    canLead: !isChecker && (byRole || role === 'team_leader'),
    canEditFiles,
    canDeleteFiles: canEditFiles || canAdmin(pu),
  };
}

/**
 * The people a Team Leader can hand files to.
 *
 * The journey divides batches among "the Pay Later employees" (¶22), so this is
 * the employees and the team leaders — the two roles that actually work a file.
 * A lawyer or auditor is deliberately NOT offered: giving them a file to
 * prepare is the thing canEditFiles above exists to prevent, and an assignee
 * who cannot open the file would be a dead end.
 */
export async function listAssignableMembers(
  companyId: string
): Promise<{ userId: string; name: string; role: string }[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('memberships')
      .select('user_id, paylater_role, app_users(full_name_en, full_name_ar, username)')
      .eq('company_id', companyId)
      .in('paylater_role', ['employee', 'team_leader']);
    if (error) throw error;

    return ((data ?? []) as Record<string, unknown>[]).map((m) => {
      const u = m.app_users as
        | { full_name_en: string | null; full_name_ar: string | null; username: string }
        | { full_name_en: string | null; full_name_ar: string | null; username: string }[]
        | null;
      const row = Array.isArray(u) ? u[0] : u;
      return {
        userId: m.user_id as string,
        name: row?.full_name_en || row?.full_name_ar || row?.username || '',
        role: (m.paylater_role as string) ?? '',
      };
    });
  } catch (err) {
    // The column may not exist yet (#35/#36 unapplied) — an empty list means
    // the assign control simply does not appear, rather than a 500.
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaylaterBatch {
  id: string;
  code: string;
  batchNo: number;
  month: string;
  capacity: number | null;
  feeModel: Record<string, unknown>;
  /** Filled by listBatches — not a column. */
  fileCount: number;
  incompleteCount: number;
}

export interface PaylaterCustomerRow {
  id: string;
  batchId: string;
  rowNo: number | null;
  nameAr: string | null;
  nameEn: string | null;
  qid: string | null;
  outstanding: number | null;
  /** v2's table shows the nationality and the total due beside the claim. */
  nationality: string | null;
  debtTotal: number | null;
  /** The unit those figures are in, as the report stated it (#38). */
  currency: string;
  noticePlanned: string | null;
  caseRegDate: string | null;
  stage: string | null;
  bucket: string | null;
  caseNumber: string | null;
  isComplete: boolean;
  orderCount: number;
  /** The three intake fields, so a list row can name what it is missing. */
  gender: string | null;
  reportDate: string | null;
  paylaterRegDate: string | null;
  /** The portal account working this file, or null if nobody has it yet. */
  assignedTo: string | null;
  assignedName: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The company's batches, each with its file count and how many of those files
 * are still incomplete — v2 shows both on every folder.
 *
 * The two counts come from one grouped read of the customers table rather than
 * a query per batch: seven batches today, but the count grows by one a month
 * and a per-batch round trip would grow with it.
 */
export async function listBatches(companyId: string): Promise<PaylaterBatch[]> {
  const supabase = getSupabaseAdmin();
  try {
    const [batchRes, custRes] = await Promise.all([
      supabase
        .from('paylater_batches')
        .select('id, code, batch_no, month, capacity, fee_model')
        .eq('company_id', companyId)
        .order('batch_no', { ascending: true }),
      /*
        COUNTED FROM THE DATA, NOT FROM THE STORED FLAG.

        `is_complete` is written at save time, and every write path has to
        remember to recompute it. Two of them did not — copying a confirmed
        gender to a person's other files, and filling a file's gaps from the
        monthly sheet both changed the answer without touching the flag. So a
        folder counted three files needing data while the table inside it,
        which computes the rule live for each row, showed two. Neither number
        was wrong about what it measured; they measured different things.

        The rule now has ONE evaluation. The flag stays for the search screen's
        chip and is kept honest by the writers, but nothing counts with it.
      */
      supabase
        .from('paylater_customers')
        .select('id, batch_id, gender, report_date, paylater_reg_date, paylater_orders(count)')
        .eq('company_id', companyId),
    ]);

    if (batchRes.error) throw batchRes.error;
    if (custRes.error) throw custRes.error;

    const counts = new Map<string, { total: number; incomplete: number }>();
    for (const c of (custRes.data ?? []) as Record<string, unknown>[]) {
      const batchId = c.batch_id as string;
      const orders = c.paylater_orders as { count: number }[] | undefined;
      const e = counts.get(batchId) ?? { total: 0, incomplete: 0 };
      e.total += 1;
      const missing = missingIntakeParts({
        gender: (c.gender as string | null) ?? null,
        reportDate: (c.report_date as string | null) ?? null,
        paylaterRegDate: (c.paylater_reg_date as string | null) ?? null,
        orderCount: orders?.[0]?.count ?? 0,
      });
      if (missing.length > 0) e.incomplete += 1;
      counts.set(batchId, e);
    }

    return ((batchRes.data ?? []) as Record<string, unknown>[]).map((b) => {
      const c = counts.get(b.id as string) ?? { total: 0, incomplete: 0 };
      return {
        id: b.id as string,
        code: b.code as string,
        batchNo: b.batch_no as number,
        month: b.month as string,
        capacity: (b.capacity as number | null) ?? null,
        feeModel: (b.fee_model as Record<string, unknown>) ?? {},
        fileCount: c.total,
        incompleteCount: c.incomplete,
      };
    });
  } catch (err) {
    if (isMissingRelationError(err)) return []; // migration #34 not applied yet
    throw err;
  }
}

/**
 * The batches WITHOUT the per-batch file counts.
 *
 * `listBatches` computes those counts by reading every customer in the company
 * — 560 rows today — and evaluating the completeness rule on each one. That is
 * the right thing to do on the dashboard, which shows the numbers.
 *
 * It is pure waste everywhere else, and most callers were everywhere else: the
 * search screen, the notes screen and the batch screen all called `listBatches`
 * and then used nothing but `id` and `code`, to label a row or fill a filter.
 * Measured against the real database, the customer scan is ~440ms against
 * ~230ms for the batch rows alone, so those screens were paying to build a
 * number they then threw away.
 *
 * `fileCount` and `incompleteCount` are deliberately absent from the return
 * type rather than returned as 0. A zero would be a lie a caller could render;
 * a missing field is a compile error. If a screen needs the counts it should
 * call `listBatches` and pay for them honestly.
 */
export type PaylaterBatchBrief = Omit<
  PaylaterBatch,
  'fileCount' | 'incompleteCount'
>;

function batchBriefFromRow(b: Record<string, unknown>): PaylaterBatchBrief {
  return {
    id: b.id as string,
    code: b.code as string,
    batchNo: b.batch_no as number,
    month: b.month as string,
    capacity: (b.capacity as number | null) ?? null,
    feeModel: (b.fee_model as Record<string, unknown>) ?? {},
  };
}

const BATCH_COLUMNS = 'id, code, batch_no, month, capacity, fee_model';

export async function listBatchBriefs(
  companyId: string
): Promise<PaylaterBatchBrief[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_batches')
      .select(BATCH_COLUMNS)
      .eq('company_id', companyId)
      .order('batch_no', { ascending: true });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(batchBriefFromRow);
  } catch (err) {
    if (isMissingRelationError(err)) return []; // migration #34 not applied yet
    throw err;
  }
}

/** One batch's files, in the batch's own row order. */
export async function listCustomers(
  companyId: string,
  batchId: string
): Promise<PaylaterCustomerRow[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_customers')
      .select(
        'id, batch_id, row_no, name_ar, name_en, qid, outstanding, nationality, debt_total, currency, notice_planned, case_reg_date, stage, bucket, case_number, is_complete, gender, report_date, paylater_reg_date, assigned_to, paylater_orders(count), assignee:app_users!paylater_customers_assigned_to_fkey(full_name_en, full_name_ar, username)'
      )
      .eq('company_id', companyId)
      .eq('batch_id', batchId)
      .order('row_no', { ascending: true, nullsFirst: false });

    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(mapCustomerRow);
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

function mapCustomerRow(r: Record<string, unknown>): PaylaterCustomerRow {
  const orders = r.paylater_orders as { count: number }[] | undefined;
  return {
    id: r.id as string,
    batchId: r.batch_id as string,
    rowNo: (r.row_no as number | null) ?? null,
    nameAr: (r.name_ar as string | null) ?? null,
    nameEn: (r.name_en as string | null) ?? null,
    qid: (r.qid as string | null) ?? null,
    outstanding: numOrNull(r.outstanding),
    nationality: (r.nationality as string | null) ?? null,
    debtTotal: numOrNull(r.debt_total),
    // Older rows predate #38; QAR is what every one of them is in.
    currency: (r.currency as string | null) ?? 'QAR',
    noticePlanned: (r.notice_planned as string | null) ?? null,
    caseRegDate: (r.case_reg_date as string | null) ?? null,
    stage: (r.stage as string | null) ?? null,
    bucket: (r.bucket as string | null) ?? null,
    caseNumber: (r.case_number as string | null) ?? null,
    isComplete: r.is_complete === true,
    orderCount: orders?.[0]?.count ?? 0,
    gender: (r.gender as string | null) ?? null,
    reportDate: (r.report_date as string | null) ?? null,
    paylaterRegDate: (r.paylater_reg_date as string | null) ?? null,
    assignedTo: (r.assigned_to as string | null) ?? null,
    assignedName: (() => {
      // Named `assignee` in the select because paylater_customers has two
      // foreign keys into app_users (created_by and assigned_to) — an unnamed
      // embed is ambiguous and PostgREST refuses it outright.
      const u = r.assignee as
        | { full_name_en: string | null; full_name_ar: string | null; username: string }
        | { full_name_en: string | null; full_name_ar: string | null; username: string }[]
        | null;
      const row = Array.isArray(u) ? u[0] : u;
      return row ? row.full_name_en || row.full_name_ar || row.username : null;
    })(),
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Search the whole company by name (either language), QID, case number or
 * enforcement number.
 *
 * QID MATCHING IS DELIBERATELY WIDER THAN THE STORED VALUE. 258 of the imported
 * records carry a trailing zero that a real QID card does not have (see the
 * header of migration #34); the decision was to leave the data exactly as
 * parsed. Search is presentation, not data, so it does not have to be that
 * literal: a typed QID is matched against the stored value AND against the same
 * value with a zero appended, so someone holding an 11-digit card finds the
 * 12-digit record without anything being rewritten.
 */
export async function searchCustomers(
  companyId: string,
  query: string,
  limit = 50
): Promise<PaylaterCustomerRow[]> {
  const q = query.trim();
  if (!q) return [];

  const supabase = getSupabaseAdmin();
  const safe = q.replace(/[%,()]/g, ' ').trim();
  if (!safe) return [];

  const terms = [
    `name_ar.ilike.%${safe}%`,
    `name_en.ilike.%${safe}%`,
    `qid.ilike.%${safe}%`,
    `case_number.ilike.%${safe}%`,
    `enf_number.ilike.%${safe}%`,
  ];
  // The trailing-zero variant, only when the query looks like a bare QID.
  if (/^\d{9,12}$/.test(safe)) terms.push(`qid.eq.${safe}0`);

  try {
    const { data, error } = await supabase
      .from('paylater_customers')
      .select(
        'id, batch_id, row_no, name_ar, name_en, qid, outstanding, notice_planned, case_reg_date, stage, bucket, case_number, is_complete, gender, report_date, paylater_reg_date, assigned_to, paylater_orders(count), assignee:app_users!paylater_customers_assigned_to_fkey(full_name_en, full_name_ar, username)'
      )
      .eq('company_id', companyId)
      .or(terms.join(','))
      .limit(limit);

    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(mapCustomerRow);
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

/**
 * The data problems found in the source files — v4's الملاحظات screen.
 *
 * Surfaced, never silently fixed. D100 #31 in particular is a guess sitting
 * under reconciled figures and is shown as one.
 */
export async function listDataIssues(companyId: string) {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_data_issues')
      .select(
        'id, kind, severity, detail, resolution, confirmed_at, batch_id, customer_id'
      )
      .eq('company_id', companyId)
      .order('severity', { ascending: true })
      .order('kind', { ascending: true });
    if (error) throw error;
    return (data ?? []) as {
      id: string;
      kind: string;
      severity: string;
      detail: string;
      resolution: string | null;
      confirmed_at: string | null;
      batch_id: string | null;
      customer_id: string | null;
    }[];
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// File numbers
// ---------------------------------------------------------------------------

/**
 * v2's rule: file numbers come from QID order within the batch — smallest QID
 * is 001. A manual override sticks, is marked يدوي, and the automatic sequence
 * WORKS AROUND IT rather than renumbering everyone.
 *
 * So: take the numbers already claimed by hand, then walk the QID-sorted list
 * handing out the lowest number nobody has claimed. Pure, and exported on its
 * own so the same rule can be tested without a database.
 *
 * QIDs are compared as strings padded to equal length, not as numbers: they
 * exceed Number.MAX_SAFE_INTEGER territory in spirit if not in fact, and a
 * leading zero (B100 #23 is `045112026`) must not be lost to numeric parsing.
 */
export function assignFileNumbers(
  people: { id: string; qid: string | null; fileNoManual: string | null }[]
): Map<string, { number: string; manual: boolean }> {
  const out = new Map<string, { number: string; manual: boolean }>();

  const claimed = new Set<string>();
  for (const p of people) {
    const m = p.fileNoManual?.trim();
    if (m) {
      claimed.add(m);
      out.set(p.id, { number: m, manual: true });
    }
  }

  const width = Math.max(1, ...people.map((p) => (p.qid ?? '').length));
  const auto = people
    .filter((p) => !p.fileNoManual?.trim())
    .sort((a, b) =>
      (a.qid ?? '').padStart(width, '0').localeCompare((b.qid ?? '').padStart(width, '0'))
    );

  let next = 1;
  for (const p of auto) {
    let candidate = String(next).padStart(3, '0');
    while (claimed.has(candidate)) {
      next += 1;
      candidate = String(next).padStart(3, '0');
    }
    out.set(p.id, { number: candidate, manual: false });
    claimed.add(candidate);
    next += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * v2's مكتمل / ناقص rule, lifted verbatim: a file is complete when it has a
 * gender, a report date, a PayLater registration date, at least one order, and
 * every order fully filled in.
 *
 * An Excel-imported customer is incomplete BY DEFINITION — order detail exists
 * only in the PDF reports — which is what the per-batch incomplete count is
 * counting down.
 */
/**
 * Intake completeness lives in lib/platform/paylaterIntake.ts, which carries no
 * `server-only` marker: the batch table and the customer form need the same
 * answer this module's callers do, and a client component cannot import from
 * here. Re-exported so server-side callers still reach it in one place.
 */
export {
  missingIntakeParts,
  isCustomerComplete,
  type IntakePart,
} from './paylaterIntake';

// ---------------------------------------------------------------------------
// One customer, whole
// ---------------------------------------------------------------------------

export interface PaylaterOrder {
  id: string;
  orderRef: string | null;
  orderDate: string | null;
  storeAr: string | null;
  storeEn: string | null;
  amount: number | null;
  instalment: number | null;
  paidCount: number | null;
  paidTotal: number | null;
  remaining: number | null;
  sortIndex: number;
}

export interface PaylaterCustomerFull {
  id: string;
  batchId: string;
  batchCode: string;
  rowNo: number | null;

  nameAr: string | null;
  nameEn: string | null;
  qidName: string | null;
  qid: string | null;
  nationality: string | null;
  gender: string | null;
  mobile: string | null;
  email: string | null;

  paylaterRegDate: string | null;
  reportDate: string | null;
  debtTotal: number | null;
  /** The unit the money on this file is in, as its report stated it (#38). */
  currency: string;
  instalmentCount: number | null;
  dpd: number | null;
  /** Ministry of Interior residency check, verbatim from the sheet (#39). */
  moiCheck: string | null;
  /** Workbook columns the portal has no field for, header → value (#40). */
  sheetExtra: Record<string, string>;
  delayMonths: number | null;
  handlerName: string | null;
  fileNoManual: string | null;

  noticePlanned: string | null;
  noticeSent: boolean;
  caseRegDate: string | null;
  caseNumber: string | null;
  courtDate: string | null;

  outstanding: number | null;
  stage: string | null;
  bucket: string | null;
  observations: string | null;
  isComplete: boolean;

  /** The parsed source record, for the "original data" tab. */
  sourceRow: Record<string, unknown>;

  orders: PaylaterOrder[];
  documents: {
    id: string;
    kind: string;
    fileName: string | null;
    storagePath: string;
    createdAt: string;
  }[];
}

/**
 * One customer with everything hanging off them.
 *
 * Company-scoped, so an id belonging to another company reads as "not found"
 * rather than as a refusal — the caller learns nothing about whether the row
 * exists elsewhere.
 */
export async function getCustomer(
  companyId: string,
  id: string
): Promise<PaylaterCustomerFull | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_customers')
      .select(
        `id, batch_id, row_no, name_ar, name_en, qid_name, qid, nationality, gender,
         mobile, email, paylater_reg_date, report_date, debt_total, currency, instalment_count,
         dpd, moi_check, sheet_extra, delay_months, handler_name, file_no_manual, notice_planned, notice_sent,
         case_reg_date, case_number, court_date, outstanding, stage, bucket,
         observations, is_complete, source_row,
         paylater_batches(code),
         paylater_orders(id, order_ref, order_date, store_ar, store_en, amount,
                         instalment, paid_count, paid_total, remaining, sort_index),
         paylater_documents(id, kind, file_name, storage_path, created_at)`
      )
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const r = data as Record<string, unknown>;
    const rel = r.paylater_batches as { code: string } | { code: string }[] | null;
    const batchCode = Array.isArray(rel) ? (rel[0]?.code ?? '') : (rel?.code ?? '');

    const orders = ((r.paylater_orders as Record<string, unknown>[] | null) ?? [])
      .map((o) => ({
        id: o.id as string,
        orderRef: (o.order_ref as string | null) ?? null,
        orderDate: (o.order_date as string | null) ?? null,
        storeAr: (o.store_ar as string | null) ?? null,
        storeEn: (o.store_en as string | null) ?? null,
        amount: numOrNull(o.amount),
        instalment: numOrNull(o.instalment),
        paidCount: numOrNull(o.paid_count),
        paidTotal: numOrNull(o.paid_total),
        remaining: numOrNull(o.remaining),
        sortIndex: (o.sort_index as number | null) ?? 0,
      }))
      .sort((a, b) => a.sortIndex - b.sortIndex);

    const documents = ((r.paylater_documents as Record<string, unknown>[] | null) ?? [])
      .map((d) => ({
        id: d.id as string,
        kind: (d.kind as string) ?? 'other',
        fileName: (d.file_name as string | null) ?? null,
        storagePath: d.storage_path as string,
        createdAt: d.created_at as string,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      id: r.id as string,
      batchId: r.batch_id as string,
      batchCode,
      rowNo: (r.row_no as number | null) ?? null,
      nameAr: (r.name_ar as string | null) ?? null,
      nameEn: (r.name_en as string | null) ?? null,
      qidName: (r.qid_name as string | null) ?? null,
      qid: (r.qid as string | null) ?? null,
      nationality: (r.nationality as string | null) ?? null,
      gender: (r.gender as string | null) ?? null,
      mobile: (r.mobile as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      paylaterRegDate: (r.paylater_reg_date as string | null) ?? null,
      reportDate: (r.report_date as string | null) ?? null,
      debtTotal: numOrNull(r.debt_total),
      currency: (r.currency as string | null) ?? 'QAR',
      instalmentCount: (r.instalment_count as number | null) ?? null,
      dpd: (r.dpd as number | null) ?? null,
      moiCheck: (r.moi_check as string | null) ?? null,
      sheetExtra: (r.sheet_extra as Record<string, string> | null) ?? {},
      delayMonths: (r.delay_months as number | null) ?? null,
      handlerName: (r.handler_name as string | null) ?? null,
      fileNoManual: (r.file_no_manual as string | null) ?? null,
      noticePlanned: (r.notice_planned as string | null) ?? null,
      noticeSent: r.notice_sent === true,
      caseRegDate: (r.case_reg_date as string | null) ?? null,
      caseNumber: (r.case_number as string | null) ?? null,
      courtDate: (r.court_date as string | null) ?? null,
      outstanding: numOrNull(r.outstanding),
      stage: (r.stage as string | null) ?? null,
      bucket: (r.bucket as string | null) ?? null,
      observations: (r.observations as string | null) ?? null,
      isComplete: r.is_complete === true,
      sourceRow: (r.source_row as Record<string, unknown>) ?? {},
      orders,
      documents,
    };
  } catch (err) {
    if (isMissingRelationError(err)) return null;
    throw err;
  }
}

/**
 * Find a customer anywhere in the company by exact QID — the duplicate check
 * the form runs before saving a new record.
 *
 * Exact, not the widened match SEARCH uses: offering someone more rows to read
 * is helpful, but treating two QIDs as the same person during a save would
 * merge two files on an inference nobody has confirmed.
 */
/**
 * EVERY OTHER FILE THIS PERSON HAS, by exact QID.
 *
 * `findByQid` answers "is this a duplicate" with one row, which is all the
 * alert banner needs. Copying a corrected name or number between a person's
 * files needs the whole set, and needs it ordered so the dialog reads the same
 * way twice.
 *
 * Exact match, like every other write path — search widens to the
 * trailing-zero variant, but treating two QIDs as one person is a claim the
 * firm has not confirmed.
 */
export async function findSiblingsByQid(
  companyId: string,
  qid: string,
  excludeId: string | null
): Promise<
  { id: string; nameAr: string | null; nameEn: string | null; batchCode: string; rowNo: number | null }[]
> {
  const q = qid.trim();
  if (!q) return [];
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_customers')
      .select('id, name_ar, name_en, row_no, paylater_batches(code)')
      .eq('company_id', companyId)
      .eq('qid', q);
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[])
      .filter((r) => r.id !== excludeId)
      .map((r) => {
        const rel = r.paylater_batches as { code: string } | { code: string }[] | null;
        return {
          id: r.id as string,
          nameAr: (r.name_ar as string | null) ?? null,
          nameEn: (r.name_en as string | null) ?? null,
          rowNo: (r.row_no as number | null) ?? null,
          batchCode: Array.isArray(rel) ? (rel[0]?.code ?? '') : (rel?.code ?? ''),
        };
      })
      .sort((a, b) => a.batchCode.localeCompare(b.batchCode));
  } catch (err) {
    if (isMissingRelationError(err)) return [];
    throw err;
  }
}

export async function findByQid(
  companyId: string,
  qid: string
): Promise<{ id: string; nameAr: string | null; nameEn: string | null; batchCode: string } | null> {
  const q = qid.trim();
  if (!q) return null;
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('paylater_customers')
      .select('id, name_ar, name_en, paylater_batches(code)')
      .eq('company_id', companyId)
      .eq('qid', q)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const rel = data.paylater_batches as { code: string } | { code: string }[] | null;
    return {
      id: data.id as string,
      nameAr: (data.name_ar as string | null) ?? null,
      nameEn: (data.name_en as string | null) ?? null,
      batchCode: Array.isArray(rel) ? (rel[0]?.code ?? '') : (rel?.code ?? ''),
    };
  } catch (err) {
    if (isMissingRelationError(err)) return null;
    throw err;
  }
}
