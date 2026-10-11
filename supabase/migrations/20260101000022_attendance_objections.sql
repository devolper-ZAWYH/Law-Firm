-- ---------------------------------------------------------------------------
-- ATTENDANCE OBJECTIONS — an employee disputing a day's late/early mark
-- (e.g. "I had permission"), sent to one or more managers of their choice.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #2 (companies/memberships) already existing.
--
-- WHAT IT DOES
--   • creates `attendance_objections` — one row per objection: the employee,
--     the calendar day being disputed, their comment, and WHICH managers they
--     chose to notify (uuid[] of app_users.id — not a join table; this list
--     is small and never queried from the "manager" side by id, only read
--     back alongside the objection itself).
--   • Delivery is via the EXISTING notifications system (a 'attendance_objection'
--     notification per selected manager) — this table is the durable record;
--     nothing new is needed for the manager to be alerted.
--
-- THE MODEL
--   • References the DAY (user_id + date), not a specific attendance_records
--     row — an employee can still object even if no record was uploaded yet
--     for that day (e.g. disputing an absence).
-- ---------------------------------------------------------------------------

create table if not exists attendance_objections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references app_users(id) on delete cascade,
  company_id         uuid not null references companies(id) on delete cascade,
  date               date not null,
  comment            text not null,
  notified_manager_ids uuid[] not null default '{}',
  created_at         timestamptz not null default now()
);

create index if not exists attendance_objections_company_idx
  on attendance_objections (company_id, created_at);
create index if not exists attendance_objections_user_idx
  on attendance_objections (user_id, date);

alter table attendance_objections enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
