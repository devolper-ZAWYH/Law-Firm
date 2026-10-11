-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — Contacts / CRM: BILINGUAL + PHONE KEY
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run).
--
-- What it does:
--   • adds bilingual columns to `contacts`: name_en / name_ar / notes_en /
--     notes_ar so a contact can carry an Arabic AND an English name/note.
--   • adds phone_country_code (international dialing code, e.g. '+974').
--   • backfills existing rows: the legacy `name`/`notes` values are copied into
--     the Arabic columns (the platform is Arabic-default), and every existing
--     row gets the Qatar dialing code '+974' as a sensible default.
--
-- The legacy `name`/`notes` columns are KEPT. `name` stays NOT NULL, so the API
-- always writes it = (name_ar || name_en || '') and legacy `notes` too. This
-- keeps older reads working while the UI shows the current-language variant.
-- ---------------------------------------------------------------------------

alter table contacts add column if not exists name_en text;
alter table contacts add column if not exists name_ar text;
alter table contacts add column if not exists notes_en text;
alter table contacts add column if not exists notes_ar text;
alter table contacts add column if not exists phone_country_code text;

-- Backfill: existing single-language data is Arabic-default here.
update contacts set name_ar = name where name_ar is null and name is not null;
update contacts set notes_ar = notes where notes_ar is null and notes is not null;
update contacts set phone_country_code = '+974' where phone_country_code is null;
