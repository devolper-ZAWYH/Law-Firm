-- ---------------------------------------------------------------------------
-- CAPABILITY APPROVALS — lets a granted capability be handed out in a
-- "may ask, may not do" form: the employee holds the permission, but each use
-- of it is held as a request until the company's approving manager signs it
-- off. Nothing runs before that decision.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run; verified by applying it twice against a database with existing
-- grant/company rows). Depends on migration #26 (membership_capability_grants)
-- and #2 (companies, app_users).
--
-- NUMBERED 31, NOT 30. It was written as #30 before a second #30
-- (attendance_objections_v2) arrived on main. The runner orders by full
-- filename, so two files sharing a number still both run, in a sequence
-- decided by whatever follows the digits — which is not a thing anyone should
-- have to reason about. Renumbered while neither name had been recorded
-- anywhere, so nothing needs backfilling.
--
-- THREE PIECES
--
--   1. membership_capability_grants.requires_approval — per (employee, company,
--      capability) flag, set by whoever grants the capability. FALSE (the
--      default, and what every existing row gets) means the grant behaves
--      exactly as it does today: the action happens immediately. Existing
--      grants are therefore completely unaffected by this migration.
--
--   2. companies.approval_manager_id — the ONE manager who decides every held
--      request in that company. ADMIN-ASSIGNED: the routes only let a global
--      admin write it, because the point of the field is that the person who
--      hands out a permission cannot also choose who polices it.
--      Nullable: a company that has never gated anything has no approver, and
--      lib/platform/approvals.ts treats "gated but no approver assigned" as a
--      hard refusal (the action is blocked, not silently allowed through) so a
--      missing assignment can never widen access.
--
--   3. capability_approval_requests — one row per held action. `payload` is the
--      already-validated arguments of the action, stored as jsonb and replayed
--      by the executor registered for `action_type`
--      (lib/platform/approvalExecutors.ts) once approved. The request records
--      the capability it came from so a later revocation can be reasoned about,
--      and keeps its decision (who, when, why) as an audit trail.
--
-- WHY THE PAYLOAD IS REPLAYED RATHER THAN THE REQUEST
--   Storing the raw HTTP body would mean re-running authorization at approval
--   time against whatever the route looks like then. Instead the route
--   validates fully, THEN parks a narrow, already-checked argument object. The
--   executor performs exactly the operation the employee asked for, nothing
--   wider. See lib/platform/approvals.ts for the re-check on execution.
-- ---------------------------------------------------------------------------

alter table membership_capability_grants
  add column if not exists requires_approval boolean not null default false;

alter table companies
  add column if not exists approval_manager_id uuid references app_users(id) on delete set null;

create table if not exists capability_approval_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  requester_id   uuid not null references app_users(id) on delete cascade,
  capability_key text not null,
  action_type    text not null,
  payload        jsonb not null default '{}'::jsonb,
  -- Human-readable one-liner ("Delete task: Draft the reply"), rendered in the
  -- approver's inbox. Snapshotted at request time because the thing it
  -- describes may be gone by the time anyone reads it.
  summary_en     text not null default '',
  summary_ar     text not null default '',
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'failed')),
  decided_by     uuid references app_users(id) on delete set null,
  decided_at     timestamptz,
  -- Why it was rejected, or why execution failed after approval.
  decision_note  text,
  created_at     timestamptz not null default now()
);

create index if not exists capability_approval_requests_inbox
  on capability_approval_requests (company_id, status, created_at desc);

create index if not exists capability_approval_requests_requester
  on capability_approval_requests (requester_id, status, created_at desc);

alter table capability_approval_requests enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
