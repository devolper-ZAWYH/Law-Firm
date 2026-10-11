-- ---------------------------------------------------------------------------
-- PAYLATER — COLUMNS THE PORTAL HAS NO FIELD FOR
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #34.
--
-- Every column in the monthly workbook that the portal does not recognise is
-- kept here, under the heading the sheet gave it. Until now those columns were
-- named in the import preview as "ignored" and their VALUES were dropped — the
-- portal could say "there is a column called MOI CHECK" and not a word about
-- what was in it.
--
-- WHY A JSON COLUMN RATHER THAN A MIGRATION EACH TIME. A column that turns out
-- to matter should get a real column, as MOI CHECK did in #39: typed, indexed,
-- and reachable from a query. But that takes a person noticing, and the cost of
-- NOT noticing is silent data loss for however many months pass in between.
-- This makes the default lossless. The next unfamiliar column arrives with its
-- data, shows up on the customer's file under its own heading, and can be
-- promoted to a real column later with the history already there.
--
-- It is deliberately not searched or reported on. It is a holding place, not a
-- schema.
-- ---------------------------------------------------------------------------

alter table paylater_customers
  add column if not exists sheet_extra jsonb not null default '{}'::jsonb;

comment on column paylater_customers.sheet_extra is
  'Columns from the monthly workbook that the portal has no field for, header → value, verbatim. A holding place so nothing is lost; promote a column that matters to a real one.';
