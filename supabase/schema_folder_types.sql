-- ---------------------------------------------------------------------------
-- FOLDER TYPES — turns folder_type from a hardcoded enum into data, so admins
-- and managers can add new types (beyond the built-in Case / Contract).
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #4 (files.folder_type) already existing.
--
-- WHAT IT DOES
--   • creates `folder_types` — a GLOBAL list (shared across all companies).
--   • seeds the two built-in types ('case', 'contract') so every existing
--     file's folder_type keeps resolving to the exact same behaviour.
--   • swaps files.folder_type's check constraint for a foreign key into
--     folder_types(key) — a validation-rule change only, no existing file's
--     folder_type value is touched.
--
-- THE MODEL
--   • `layout` is one of the two EXISTING field behaviours ('case' = client +
--     opponent, 'contract' = client only) — new types pick one, they don't
--     invent new layouts.
--   • `is_builtin` types cannot be deleted (no delete UI exists at all yet).
-- ---------------------------------------------------------------------------

create table if not exists folder_types (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  label_en    text not null,
  label_ar    text not null,
  layout      text not null check (layout in ('case', 'contract')),
  is_builtin  boolean not null default false,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now()
);

alter table folder_types enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)

insert into folder_types (key, label_en, label_ar, layout, is_builtin)
values
  ('case', 'Case', 'قضية', 'case', true),
  ('contract', 'Contract', 'عقد', 'contract', true)
on conflict (key) do nothing;

-- Swap the old fixed check constraint for a foreign key into folder_types.
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'files_folder_type_chk'
  ) then
    alter table files drop constraint files_folder_type_chk;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_folder_type_fk'
  ) then
    alter table files
      add constraint files_folder_type_fk
      foreign key (folder_type) references folder_types(key);
  end if;
end $$;
