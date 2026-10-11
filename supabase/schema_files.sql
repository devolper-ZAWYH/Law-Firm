-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 2 (Files) schema
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run). It depends on Phase 1
--     (companies + app_users) already existing — run schema_platform.sql first.
--
-- What it does:
--   • creates `files` — one row per legal file, scoped to a company.
--   • enables RLS deny-by-default (service-role only, like every other table).
--
-- THE MODEL — a file belongs to exactly ONE company (hard isolation boundary).
-- Authorization is enforced SERVER-SIDE (lib/platform/auth.ts + the API routes):
--   • create file         → global admin only
--   • list / view file    → admin (any company) or a member of the file's
--                            company whose role permits it
--   • move file section   → admin, or a MANAGER of the file's company
--
-- COLOR IS NOT STORED. A file's color is DERIVED from its (future) tasks by the
-- color engine (Phase 5). Until tasks exist (Phase 4) the UI shows the SECTION's
-- static starting color: potential→light-gray, active→yellow, expired→green.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- files
-- ---------------------------------------------------------------------------
create table if not exists files (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  client          text not null,
  opponent        text not null,
  managing_lawyer text not null,
  drive_link      text,
  section         text not null default 'potential'
                    check (section in ('potential', 'active', 'expired')),
  created_by      uuid not null references app_users(id),
  created_at      timestamptz not null default now()
);

create index if not exists files_company_idx on files (company_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default, exactly like companies/memberships.
-- No anon/authenticated policies are created on purpose: the table is entirely
-- inaccessible from the browser (anon key). All access is server-side with the
-- service-role key, which BYPASSES RLS for trusted server code.
-- ---------------------------------------------------------------------------
alter table files enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
