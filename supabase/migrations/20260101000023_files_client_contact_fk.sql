-- ---------------------------------------------------------------------------
-- FILES.CLIENT_CONTACT_ID — the FK into contacts(id), added separately.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #5 (files.client_contact_id column) AND
-- migration #10 (contacts table) already existing — this file must run
-- after BOTH, which is why it's numbered here rather than immediately after
-- #5 (contacts doesn't exist yet at that point in the sequence).
--
-- WHAT IT DOES
--   • adds the foreign key files.client_contact_id → contacts(id),
--     ON DELETE SET NULL, so removing a contact never deletes a folder (it
--     falls back to its legacy `files.client` text).
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_client_contact_id_fkey'
  ) then
    alter table files
      add constraint files_client_contact_id_fkey
      foreign key (client_contact_id) references contacts(id) on delete set null;
  end if;
end $$;
