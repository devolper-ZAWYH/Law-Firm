-- ---------------------------------------------------------------------------
-- PAYLATER — THE MOI RESIDENCY CHECK FROM THE MONTHLY SHEET
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #34.
--
-- The firm's monthly workbook carries thirteen columns. Twelve were mapped and
-- one, "MOI CHECK", was read and thrown away as unrecognised — on every row of
-- every batch, and it is filled in for all 100 rows of the batch this was
-- written against.
--
-- WHAT IT IS. The Ministry of Interior residency check: "IN" means the customer
-- is in the country. The value that matters is the other one — a notice cannot
-- be served on somebody who has left, so a file marked otherwise is one the
-- enforcement step has to treat differently. Dropping it meant that fact
-- reached the portal and then vanished.
--
-- Stored as free text, not a boolean. The sheet writes "IN" and "in" today; a
-- column that can only be true or false would force a reading on whatever it
-- says next month, and this data's history is a series of surprises about what
-- a column can contain.
-- ---------------------------------------------------------------------------

alter table paylater_customers
  add column if not exists moi_check text;

comment on column paylater_customers.moi_check is
  'Ministry of Interior residency check, verbatim from the monthly workbook''s MOI CHECK column ("IN" = in the country). Free text on purpose.';
