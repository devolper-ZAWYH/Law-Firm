-- ---------------------------------------------------------------------------
-- ATTRITION — a 4th file section, alongside potential / active / expired.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #3 (files.section) already existing.
--
-- WHAT IT DOES
--   • widens files.section's allowed values to also include 'attrition'.
--     This is a validation-rule change only — no existing row has this value,
--     so nothing is touched.
--
-- THE MODEL
--   • 'attrition' is terminal, like 'expired': a file the client dropped or a
--     contract terminated early. Excluded from an employee's "My Files" view
--     (no pending work), included in Admin/Manager folder views with its own
--     tab and color.
-- ---------------------------------------------------------------------------

-- Drop the original inline check constraint (Postgres' default auto-generated
-- name for an unnamed column check declared inside CREATE TABLE).
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'files_section_check'
  ) then
    alter table files drop constraint files_section_check;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_section_chk'
  ) then
    alter table files
      add constraint files_section_chk
      check (section in ('potential', 'active', 'expired', 'attrition'));
  end if;
end $$;
