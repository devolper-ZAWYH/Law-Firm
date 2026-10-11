-- ---------------------------------------------------------------------------
-- MEMBERSHIP PERMISSIONS — per-employee, per-company extra responsibilities.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #2 (memberships) already existing.
--
-- WHAT IT DOES
--   • creates `membership_permissions` — one row per (user, company), each
--     column an independent boolean grant. Every action defaults to false —
--     nothing changes for any existing membership until an admin/manager
--     explicitly grants a permission.
--
-- THE MODEL
--   • These flags let an admin or manager hand an EMPLOYEE membership one or
--     more manager-level abilities individually — e.g. an employee could get
--     can_create_file without also getting can_delete_file.
--   • A 'manager' or 'admin' role already has full access regardless of these
--     flags — they only ADD capability to an 'employee' membership, never
--     remove anything from a manager/admin.
-- ---------------------------------------------------------------------------

create table if not exists membership_permissions (
  user_id                 uuid not null references app_users(id) on delete cascade,
  company_id              uuid not null references companies(id) on delete cascade,
  can_create_file         boolean not null default false,
  can_edit_file           boolean not null default false,
  can_delete_file         boolean not null default false,
  can_move_file_section   boolean not null default false,
  can_create_task         boolean not null default false,
  can_manage_file_access  boolean not null default false,
  updated_at              timestamptz not null default now(),
  primary key (user_id, company_id)
);

alter table membership_permissions enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
