-- ---------------------------------------------------------------------------
-- FOLDER TYPE — 'case' (court case) vs 'contract'
--
-- ⚠️  OPERATOR ACTION REQUIRED: run this whole file ONCE in the Supabase SQL
--     Editor (or via psql using DATABASE_URL). It is idempotent (safe to
--     re-run). Depends on schema_files.sql already having created `files`.
--
-- WHAT IT DOES
--   • adds files.folder_type, defaulting to 'case' so EVERY existing folder
--     keeps its current Client / vs / Opponent behaviour untouched.
--   • constrains it to the two allowed values.
--
-- THE MODEL
--   • 'case'     → the folder has a CLIENT and an OPPONENT; the title renders
--                  as the stacked client / vs (red) / opponent.
--   • 'contract' → the folder has ONLY a CLIENT; opponent_en/opponent_ar are
--                  forced to NULL on write and the title renders the client
--                  alone (no "vs" line).
--
-- Both types still REQUIRE a client contact. Nothing else changes: creation and
-- core edits stay admin-only, and per-company isolation is untouched.
-- ---------------------------------------------------------------------------

alter table files
  add column if not exists folder_type text not null default 'case';

-- allowed values: 'case' | 'contract'
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_folder_type_chk'
  ) then
    alter table files
      add constraint files_folder_type_chk
      check (folder_type in ('case', 'contract'));
  end if;
end $$;
