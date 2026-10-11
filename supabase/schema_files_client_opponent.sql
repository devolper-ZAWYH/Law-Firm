-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — FILES: CRM client link + bilingual opponent
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run).
--
-- What it does:
--   • adds `files.client_contact_id` — a nullable uuid column (the FK
--     constraint into contacts(id) is added separately, in migration #23,
--     because `contacts` isn't created until migration #10 — this file
--     predates it in the sequence). The folder's client is now CHOSEN from
--     the company's CRM contacts (no free typing); once the FK lands, ON
--     DELETE SET NULL means removing a contact never deletes a folder — the
--     folder falls back to its legacy `files.client` text.
--   • adds bilingual opponent columns: `opponent_en` / `opponent_ar`, so a
--     folder can carry an Arabic AND an English opponent name.
--   • backfills existing rows: the legacy `opponent` value is copied into the
--     Arabic column (the platform is Arabic-default).
--
-- The legacy `files.client` and `files.opponent` columns are KEPT and stay
-- NOT NULL. The API always writes them:
--   • files.client   = the selected contact's display name (name_ar||name_en||name)
--   • files.opponent = (opponent_ar || opponent_en)
-- This keeps older / non-joined reads working while the UI resolves the
-- current-language client (from the joined contact) and opponent.
-- ---------------------------------------------------------------------------

alter table files
  add column if not exists client_contact_id uuid;
alter table files add column if not exists opponent_en text;
alter table files add column if not exists opponent_ar text;

-- Backfill: existing single-language opponent data is Arabic-default here.
update files set opponent_ar = opponent where opponent_ar is null and opponent is not null;

-- Helpful when resolving a folder's client by its linked contact.
create index if not exists idx_files_client_contact_id on files (client_contact_id);
