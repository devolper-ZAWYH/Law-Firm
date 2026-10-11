-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 3 (File-access lifecycle)
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run). It depends on Phase 1
--     (companies + app_users + memberships) and Phase 2 (files) already
--     existing — run schema_platform.sql and schema_files.sql first.
--
-- What it does:
--   • creates `file_access`     — who (which employee) is currently ON a file.
--   • creates `access_requests` — a Manager's PENDING request to add an
--                                 employee to a file, awaiting Admin approval.
--   • enables RLS deny-by-default on both (service-role only, like every other
--     table).
--
-- THE MODEL — the access gate is deliberately ASYMMETRIC and two-layer, enforced
-- SERVER-SIDE (lib/platform/auth.ts + lib/platform/access.ts + the API routes):
--   • ADD is HARD  → a Manager (or Admin) REQUESTS; only a global Admin APPROVES,
--                    which is what actually creates the file_access row. A
--                    pending request grants ZERO capability.
--   • REMOVE is EASY → a Manager (or Admin) of the file's company removes an
--                      employee directly, no approval. A file must always keep
--                      ≥1 assignee (last-person guard, enforced in code).
--
-- Company isolation is a hard boundary: a request's target employee must be an
-- `employee` member of the SAME company as the file (enforced in code).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- file_access — one row per (file, employee) that currently has the file.
-- ---------------------------------------------------------------------------
create table if not exists file_access (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references files(id)     on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  unique (file_id, user_id)
);

create index if not exists file_access_file_idx on file_access (file_id);
create index if not exists file_access_user_idx on file_access (user_id);

-- ---------------------------------------------------------------------------
-- access_requests — a Manager's request to add an employee, pending Admin review.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'access_request_status') then
    create type access_request_status as enum ('pending', 'approved', 'rejected');
  end if;
end
$$;

create table if not exists access_requests (
  id           uuid primary key default gen_random_uuid(),
  file_id      uuid not null references files(id)     on delete cascade,
  user_id      uuid not null references app_users(id) on delete cascade, -- the employee to add
  requested_by uuid not null references app_users(id),                   -- the manager
  status       access_request_status not null default 'pending',
  decided_by   uuid references app_users(id),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

create index if not exists access_requests_file_idx   on access_requests (file_id);
create index if not exists access_requests_status_idx on access_requests (status);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default, exactly like every other platform table.
-- No anon/authenticated policies on purpose: the tables are entirely
-- inaccessible from the browser (anon key). All access is server-side with the
-- service-role key, which BYPASSES RLS for trusted server code.
-- ---------------------------------------------------------------------------
alter table file_access     enable row level security;
alter table access_requests enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
