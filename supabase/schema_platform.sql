-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 1 (Foundation) schema
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run).
--
-- What it does:
--   • creates `companies`
--   • EXTENDS the existing `app_users` table (adds is_admin + full names)
--   • creates `memberships` (the core (user, company, role) join)
--   • enables RLS deny-by-default on the new tables (all access is server-side
--     via the service-role key, exactly like the existing app_users table)
--
-- THE CORE MODEL — a person does NOT have a single role. A person has
-- MEMBERSHIPS: each membership = (user, company, role ∈ {manager,employee}).
-- PLUS one global boolean flag app_users.is_admin (master key over ALL
-- companies). Authorization is two-layer and enforced SERVER-SIDE:
--   (1) if caller.is_admin  → allow admin-level actions globally
--   (2) else                → require a membership in the TARGET company whose
--                             role permits the action.
-- Company isolation is a hard boundary: non-admins only ever see data for
-- companies they hold a membership in.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id                  uuid primary key default gen_random_uuid(),
  name_en             text not null,
  name_ar             text not null,
  -- ISO-ish weekday integers that are working days. 0=Sunday … 6=Saturday.
  -- Sun–Thu by default (the Gulf working week).
  working_days        int[] not null default '{0,1,2,3,4}',
  -- Color engine (later phase): how many working days = one color step.
  days_per_color_step int  not null default 3,
  -- Telegram notifications (later phase). Nullable until configured.
  telegram_bot_token  text,
  telegram_chat_id    text,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- app_users — EXTEND the existing table (do NOT recreate it).
--
-- The legacy `role` column (admin/manager/user) is intentionally KEPT so the
-- current email/password login keeps working unchanged. It is now LEGACY: the
-- NEW authorization model uses `is_admin` + the `memberships` table, NOT this
-- column. Leave it in place for now; a later phase can drop it.
-- ---------------------------------------------------------------------------
alter table app_users
  add column if not exists is_admin     boolean not null default false;
alter table app_users
  add column if not exists full_name_en text;
alter table app_users
  add column if not exists full_name_ar text;

-- ---------------------------------------------------------------------------
-- memberships — the core join. (user, company, role).
-- A user has AT MOST ONE membership per company (UNIQUE). Global admins do NOT
-- need a membership to act on a company, but Yousef holds manager memberships
-- in all three anyway (see seed).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_role') then
    create type membership_role as enum ('manager', 'employee');
  end if;
end
$$;

create table if not exists memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role       membership_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create index if not exists memberships_user_idx    on memberships (user_id);
create index if not exists memberships_company_idx on memberships (company_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default on the new tables.
-- We deliberately create NO anon/authenticated policies, so the tables are
-- completely inaccessible from the browser (anon key). All access happens
-- server-side with the service-role key, which BYPASSES RLS — the same pattern
-- already used for app_users.
-- ---------------------------------------------------------------------------
alter table companies   enable row level security;
alter table memberships enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
