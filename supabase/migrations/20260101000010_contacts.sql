-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 8 (Contacts / CRM) schema
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run).
--
-- What it does:
--   • creates `contacts` — a per-company address book (CRM).
--   • indexes contacts by company for the per-company listing.
--   • enables RLS deny-by-default (all access is server-side via the
--     service-role key, exactly like every other platform table).
--
-- AUTHORIZATION (enforced SERVER-SIDE, see the API routes):
--   • view   → any MEMBER of the company (admin: any company).
--   • create / edit / delete → ADMIN ONLY (global is_admin).
-- Company isolation is a hard boundary: contacts are scoped to company_id.
--
-- Phases 8's Employees + Instructions features need NO schema changes — this is
-- the ONLY migration for Phase 8.
-- ---------------------------------------------------------------------------

create table if not exists contacts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  phone      text,
  email      text,
  notes      text,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create index if not exists contacts_company_idx on contacts (company_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default. No anon/authenticated policies on
-- purpose, so the table is inaccessible from the browser (anon key). All access
-- happens server-side with the service-role key, which BYPASSES RLS.
-- ---------------------------------------------------------------------------
alter table contacts enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
