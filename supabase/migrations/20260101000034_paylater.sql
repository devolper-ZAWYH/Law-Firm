-- ---------------------------------------------------------------------------
-- PAYLATER PORTAL — BATCHES, CUSTOMERS, ORDERS, DOCUMENTS, HISTORY, ISSUES
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #2 (companies, memberships) and
-- #1 (app_users). Nothing here alters or drops an existing object.
--
-- WHAT THIS IS
--   A second portal for the firm's PayLater debt-recovery work, scoped to one
--   company. The spec (docs/superpowers/specs/paylater-portal.md) settled the
--   shape: build v2's SCREENS on v4's DATA MODEL. So these tables store the
--   UNION of v4's 48-field case record and v2's intake fields. Nothing from
--   either is dropped, which is what lets v4's dashboards and reports be added
--   later without a migration.
--
-- THE TWO HALVES, AND WHY FOUR FIELD NAMES DIVERGE FROM BOTH SOURCES
--   v2 and v4 each use a short name for a different thing. Collapsing them
--   would silently merge two facts, so each is renamed to say which it is:
--
--     v2 `reg`   → paylater_reg_date   the customer registered with PayLater
--     v4 `reg_date` / v2 `creg`
--                → case_reg_date       the case was registered with the court
--     v2 `total` → debt_total          the debt total, read off the PDF report
--     v4 `total_amount`
--                → judgment_total      principal + compensation + court fees
--
--   v4 `outstanding` (the claim as it stands in the monthly Excel) is kept
--   under its own name alongside debt_total: they are read from different
--   documents at different times and disagreeing is itself information.
--
-- QID IS TEXT, AND IS NOT UNIQUE AT THE DATABASE LEVEL
--   Qatari QIDs are 11 digits. In the v4 dataset 258 of 560 records carry 12
--   digits, every one of them ending in `0`, and dropping that trailing zero
--   yields a valid 11-digit QID in all 258 cases — an Excel numeric-format
--   artifact in the source, not 258 different people. Two more are plainly
--   broken: B100 #23 is `045112026` (a date) and B100 #40 is `20`.
--
--   The spec's rule for source-data problems is "import as the parser decided,
--   surface it, do not bury it", and the decision taken on this one is to infer
--   NOTHING: `qid` holds the value verbatim, and the importer writes
--   `qid_normalized` as an exact copy of it. The anomaly is reported in the
--   notes screen and left in the data.
--
--   `qid_normalized` therefore looks redundant today, and is kept on purpose.
--   It is the seam: if the firm ever confirms the trailing zero is a format
--   artifact, one importer change fills this column and matching improves with
--   no migration and no edit to the verbatim `qid`. Readers match on it now so
--   that change stays a one-line change.
--
--   SEARCH is presentation, not data, and does not have to be this literal —
--   the customer search matches a typed QID against both the stored value and
--   its trailing-zero variant, so someone holding an 11-digit card can find a
--   12-digit record without anything being rewritten.
--
--   No unique constraint on either: v2's duplicate-skip is an intake rule
--   ("keep the richer record"), and a database that refuses the row instead
--   turns a known, reportable data problem into a failed import. Uniqueness is
--   enforced where the decision can be explained to someone — in the importer,
--   against qid_normalized.
--
-- STAGE AND BUCKET ARE FREE TEXT
--   Following the note in #32: a closed list that does not contain the right
--   value is worse than a field someone can type into. Gates are NOT enforced
--   this milestone, and the pipeline in WORKFLOW_GATES_spec.md will add stages.
--   The values seen in the 560 real records are:
--     stage  — notice_planned, notice_sent, case_filed, awaiting_hearing,
--              judgment, paid_after_judgment, settled_pre_case,
--              settled_post_case, enforcement
--     bucket — settlement, pre_enforcement, enforcement, archived, or NULL
--              (98 records sit in no bucket; A100 #22 is a flagged example)
--
-- MONEY IS numeric(14,3)
--   Not 2 decimals. The firm's own reconciled totals carry three — archived is
--   431,751.405 and A100 collected is 174,172.565 — and rounding at write time
--   would break the reconciliation the v4 parser validates itself against.
--
-- `fees` AND `enf` ARE jsonb
--   Both are computed money breakdowns (6 and 17 keys) that travel together and
--   are never queried by one member. jsonb keeps every key without spending 23
--   columns, and the fee model differs per batch (3,000 court fee for batches
--   1–5; +5,000 kafalah from batch 6), so a per-record snapshot is what keeps
--   historical totals correct when the model changes again.
--
-- STAGE AND HISTORY FROM DAY ONE
--   paylater_history is written now even though gates are not enforced, so the
--   gated pipeline can be switched on later with no migration — a decision the
--   spec makes explicitly.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- BATCHES — monthly, created in the portal, not hard-coded.
--
-- v2 ships a fixed A10…F100 list, which needs a deploy to add September. A
-- Team Leader creates the month's batch here instead. The 7 existing batches
-- (A10, A50, A100, B100, C100, D100, E100 — February to August) import as they
-- are, keeping their own numbering.
-- ---------------------------------------------------------------------------
create table if not exists paylater_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  code         text not null,
  -- Sequence within the programme. Drives the fee model: kafalah applies from
  -- batch 6 onward, so this is stored, not derived from creation order.
  batch_no     integer not null,
  -- The month the batch covers, as the firm writes it ("FEBRUARY"). Free text:
  -- the source spells it in English caps and the label is shown, not parsed.
  month        text not null,
  -- What the batch is meant to hold. v2 warns when an import would exceed it;
  -- it does not refuse, because the real batch is whatever the Excel contains.
  capacity     integer,
  created_by   uuid references app_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (company_id, code)
);

create index if not exists paylater_batches_company_idx
  on paylater_batches (company_id, batch_no);


-- ---------------------------------------------------------------------------
-- CUSTOMERS — one row per file. The union of both source records.
-- ---------------------------------------------------------------------------
create table if not exists paylater_customers (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  batch_id          uuid not null references paylater_batches(id) on delete restrict,

  -- ---- identity ---------------------------------------------------------
  -- Row number within the batch, as printed in the Progress Report. Kept
  -- because the firm refers to files by it ("D100 #31") and because it is
  -- exactly where the source is known to be wrong — see paylater_data_issues.
  row_no            integer,
  name_ar           text,
  name_en           text,
  -- The name as written on the QID card, which is not always either of the
  -- above; v2 keeps it separate so a garbled Excel name can be corrected
  -- against the card without losing what the card actually said.
  qid_name          text,
  qid               text,
  qid_normalized    text,
  nationality       text,
  -- v2 offers a dropdown rather than inferring from the name. The spec is
  -- explicit that inference is the less reliable answer.
  gender            text,
  mobile            text,
  email             text,

  -- ---- intake (v2) ------------------------------------------------------
  paylater_reg_date date,
  report_date       date,
  debt_total        numeric(14,3),
  instalment_count  integer,
  dpd               integer,
  delay_months      integer,
  -- The employee handling the file, as typed in v2's form. Free text, not an
  -- app_users FK: the source data names people who may have no portal account.
  handler_name      text,
  -- v2's rule: file numbers come from QID order, smallest QID is 001. A manual
  -- override sticks, is marked يدوي, and the automatic sequence works around
  -- it. NULL means "use the computed number"; the computed value is not stored
  -- because it changes whenever a customer is added to the batch.
  file_no_manual    text,

  -- ---- notice -----------------------------------------------------------
  notice_planned    date,
  notice_sent       boolean not null default false,
  notice_email_only boolean not null default false,
  -- The source column verbatim ("yes (whatsapp + email)", "yesyes"). The
  -- parser reads a date as planned and YES as done; keeping the original text
  -- is what lets someone check that reading when a value looks wrong.
  notice_raw        text,

  -- ---- settlement before the case --------------------------------------
  settled_pre         boolean not null default false,
  settled_pre_amount  numeric(14,3),
  settled_pre_partial boolean not null default false,
  settled_pre_raw     text,

  -- ---- the case ---------------------------------------------------------
  case_reg_date     date,
  case_filed        boolean not null default false,
  case_fees_paid    boolean not null default false,
  case_fees_raw     text,
  case_number       text,
  case_status       text,
  case_status_raw   text,
  court_date        date,

  -- ---- judgment ---------------------------------------------------------
  has_judgment      boolean not null default false,
  judg_outstanding  numeric(14,3),
  judg_compensation numeric(14,3),
  judg_fees         numeric(14,3),
  judgment_raw      text,
  judgment_total    numeric(14,3),

  -- ---- settlement after the case ---------------------------------------
  settled_post        boolean not null default false,
  settled_post_amount numeric(14,3),
  settled_post_raw    text,
  paid_after_judgment        boolean not null default false,
  paid_after_judgment_amount numeric(14,3),

  -- ---- enforcement ------------------------------------------------------
  enf_registered    boolean not null default false,
  enf_fees_paid     boolean not null default false,
  enf_number        text,
  -- Parsed out of the free-text Observations column: bank_funds, vehicle,
  -- sell_shares, travel_ban, salary, other.
  enf_requests      text[] not null default '{}',

  -- ---- money and position ----------------------------------------------
  -- The claim as it stands in the monthly Excel. Distinct from debt_total,
  -- which is read off the customer's PDF report. See the header note.
  outstanding       numeric(14,3),
  total_due         numeric(14,3),
  received          numeric(14,3),
  fees              jsonb not null default '{}'::jsonb,
  enf               jsonb not null default '{}'::jsonb,
  stage             text,
  bucket            text,
  observations      text,
  procedures        text,

  -- ---- completeness -----------------------------------------------------
  -- v2 shows مكتمل / ناقص per row and counts the incomplete per folder.
  -- Excel-imported customers start incomplete by definition: order detail
  -- exists only in the PDFs. Stored rather than computed on read so the
  -- batch-level counts do not have to load every order of every customer.
  is_complete       boolean not null default false,

  -- The original spreadsheet row, kept whole. v4's "البيانات الأصلية" tab
  -- exists for when a parsed value looks wrong and someone needs the wording
  -- the parser was working from.
  source_row        jsonb not null default '{}'::jsonb,

  created_by        uuid references app_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists paylater_customers_batch_idx
  on paylater_customers (batch_id, row_no);
-- Search by QID is the common lookup and the importer's duplicate check.
create index if not exists paylater_customers_qid_idx
  on paylater_customers (company_id, qid_normalized);
create index if not exists paylater_customers_case_idx
  on paylater_customers (company_id, case_number);
create index if not exists paylater_customers_enf_idx
  on paylater_customers (company_id, enf_number);
create index if not exists paylater_customers_stage_idx
  on paylater_customers (company_id, stage);
create index if not exists paylater_customers_bucket_idx
  on paylater_customers (company_id, bucket);


-- ---------------------------------------------------------------------------
-- ORDERS — the customer's PayLater purchases.
--
-- One row per order, not a jsonb array on the customer: v2 validates each
-- order individually (every field required, paid + remaining must equal the
-- amount, remaining totals must sum to the debt) and the delay calculation
-- sorts them by date. Rows make those checks and that sort ordinary SQL.
--
-- This detail exists ONLY in the customer report PDFs — the monthly Excel does
-- not carry it, which is why an Excel-imported customer is incomplete until
-- his report is uploaded.
-- ---------------------------------------------------------------------------
create table if not exists paylater_orders (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references paylater_customers(id) on delete cascade,
  -- PayLater's own order id ("SQ1767219705137871"). Not unique: the same order
  -- appearing twice is a data problem to surface, not a row to refuse.
  order_ref    text,
  order_date   date,
  -- Merchant name in both languages. v2's extraction rule is that the Arabic
  -- name is taken verbatim from the Arabic column, never translated.
  store_ar     text,
  store_en     text,
  amount       numeric(14,3),
  instalment   numeric(14,3),
  paid_count   integer,
  paid_total   numeric(14,3),
  remaining    numeric(14,3),
  -- Position within the customer's list, oldest first — v2's ordering rule.
  sort_index   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists paylater_orders_customer_idx
  on paylater_orders (customer_id, sort_index);


-- ---------------------------------------------------------------------------
-- DOCUMENTS — Supabase Storage references.
--
-- Storage holds the bytes; this table holds who uploaded what and where it
-- sits, so access can be resolved server-side like every other data path here.
-- The row carries no signed URL: those are minted per request.
-- ---------------------------------------------------------------------------
create table if not exists paylater_documents (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references paylater_customers(id) on delete cascade,
  -- What the file is: 'report' (the PayLater customer report PDF), 'qid' (the
  -- ID card image), 'notice', 'judgment', 'other'. Free text for the same
  -- reason as stage — the document set grows with the workflow.
  kind         text not null default 'other',
  storage_path text not null,
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references app_users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists paylater_documents_customer_idx
  on paylater_documents (customer_id, kind);


-- ---------------------------------------------------------------------------
-- HISTORY — the file's life, written from day one.
--
-- Gates are not enforced this milestone, but the spec requires stage and
-- history to exist now so the gated pipeline can be switched on later without
-- a migration. Every stage change, edit and import writes a row.
-- ---------------------------------------------------------------------------
create table if not exists paylater_history (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references paylater_customers(id) on delete cascade,
  -- 'imported', 'stage_changed', 'edited', 'document_added', 'merged', …
  event        text not null,
  stage_from   text,
  stage_to     text,
  -- What changed, for an edit. Kept loose: the shape differs per event.
  detail       jsonb not null default '{}'::jsonb,
  actor_id     uuid references app_users(id) on delete set null,
  -- The importer is not a person. When actor_id is null this names what wrote
  -- the row ("import:v4-dataset", "import:excel").
  actor_label  text,
  created_at   timestamptz not null default now()
);

create index if not exists paylater_history_customer_idx
  on paylater_history (customer_id, created_at desc);


-- ---------------------------------------------------------------------------
-- DATA ISSUES — problems in the source files, flagged and not fixed.
--
-- v4's notes screen. The three the parser already reports (D100's duplicate
-- row number, D100 row 98's misplaced case number, A100 #22 in no bucket) plus
-- the QID anomalies described in the header. `resolution` is how the import
-- chose to proceed, so a reader can see the guess as a guess.
--
-- D100 #31 in particular is a guess sitting under reconciled figures: two rows
-- were numbered 1 and #31 was missing, and the larger claim was assigned #31
-- to make the totals reconcile. The user has NOT confirmed it.
-- ---------------------------------------------------------------------------
create table if not exists paylater_data_issues (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  batch_id     uuid references paylater_batches(id) on delete cascade,
  customer_id  uuid references paylater_customers(id) on delete cascade,
  -- 'duplicate_row_number', 'misplaced_case_number', 'no_bucket',
  -- 'qid_trailing_zero', 'qid_malformed', …
  kind         text not null,
  -- 'error' | 'warn'
  severity     text not null default 'warn',
  detail       text not null,
  -- What the import did about it, in words. Null when it did nothing.
  resolution   text,
  -- Set when someone confirms the guess was right (or corrects it).
  confirmed_by uuid references app_users(id) on delete set null,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists paylater_data_issues_company_idx
  on paylater_data_issues (company_id, severity, kind);


-- ---------------------------------------------------------------------------
-- EXCEPTIONS — a file's structured exceptions, from v4's ملاحظات واستثناءات.
--
-- Distinct from data issues: those are problems with the SOURCE, these are
-- facts about the DEBTOR (سداد جزئي · تعليق مؤقت · اعتراض العميل · وفاة ·
-- غادر البلاد · أخرى). An open exception raises a banner on the file.
-- ---------------------------------------------------------------------------
create table if not exists paylater_exceptions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references paylater_customers(id) on delete cascade,
  -- 'partial_payment' | 'suspended' | 'objection' | 'deceased' | 'left_country'
  -- | 'other'
  kind         text not null,
  amount       numeric(14,3),
  note         text,
  resolved_at  timestamptz,
  created_by   uuid references app_users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists paylater_exceptions_customer_idx
  on paylater_exceptions (customer_id) where resolved_at is null;


-- ---------------------------------------------------------------------------
-- The fee model, per batch, as a snapshot.
--
-- A10 → C100 (batches 1–5): 3,000 court fee.
-- D100 onward (batch 6+): 3,000 + 5,000 kafalah = 8,000 per case.
-- Modelled per batch rather than as a constant so historical totals stay
-- correct when the model changes again. Kafalah is recoverable from the court
-- on settlement.
-- ---------------------------------------------------------------------------
alter table paylater_batches
  add column if not exists fee_model jsonb not null default '{}'::jsonb;
