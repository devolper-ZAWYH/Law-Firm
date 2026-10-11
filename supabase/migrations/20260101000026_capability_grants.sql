-- ---------------------------------------------------------------------------
-- MEMBERSHIP CAPABILITY GRANTS — per-employee, per-company grants against the
-- full capability tree (lib/platform/capabilities.ts), superseding the seven
-- flat booleans in membership_permissions with ~40 individually grantable
-- capabilities.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #16 (membership_permissions) already existing.
--
-- WHAT IT DOES
--   • creates `membership_capability_grants` — one row per (user, company,
--     capability_key). A row's presence means that key is granted; there is
--     no boolean column, so adding a new capability to the tree never needs a
--     migration. Every membership starts with zero rows — nothing changes
--     until an admin/manager explicitly grants a capability.
--
-- THE MODEL
--   • Same "extra responsibility" model as membership_permissions: a 'manager'
--     or 'admin' role already has full access regardless of these rows — they
--     only ADD capability to an 'employee' membership.
--   • lib/platform/capabilityGrants.ts keeps this table and the legacy
--     membership_permissions booleans in sync for the seven actions that
--     already have server-side enforcement (see LEGACY_CAPABILITY_MAP in
--     capabilities.ts), so granting via the new tree keeps working with
--     existing checks. Capabilities without a legacy counterpart are stored
--     here only, ready for enforcement to be wired up later.
-- ---------------------------------------------------------------------------

create table if not exists membership_capability_grants (
  user_id         uuid not null references app_users(id) on delete cascade,
  company_id      uuid not null references companies(id) on delete cascade,
  capability_key  text not null,
  granted_at      timestamptz not null default now(),
  granted_by      uuid references app_users(id) on delete set null,
  primary key (user_id, company_id, capability_key)
);

create index if not exists membership_capability_grants_lookup
  on membership_capability_grants (user_id, company_id);

alter table membership_capability_grants enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
