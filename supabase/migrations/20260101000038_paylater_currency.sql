-- ---------------------------------------------------------------------------
-- PAYLATER — THE CURRENCY A FILE'S MONEY IS IN
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #34.
--
-- WHY A COLUMN AND NOT A CONSTANT. Every amount in every report read so far is
-- QAR: 283 amounts across the 73 reports of Batch 7, each printed twice (the
-- Arabic "ر.ق" beside the ISO "QAR"). It would be reasonable to write "QAR" in
-- the template and move on.
--
-- It is stored because the report STATES it, and a figure that goes onto a
-- legal notice should carry the unit the source gave it rather than one the
-- software assumed. The parser used to have "QAR" written into the pattern that
-- finds the total, which meant a report in any other currency would not match
-- and would lose its total silently — reading as a thin PDF rather than as a
-- wrong assumption. That is the failure this column exists to make impossible.
--
-- DEFAULT 'QAR', because the 560 already imported came from a spreadsheet that
-- names no currency and they are all Qatari debts. The default is the honest
-- reading of that data, not a guess about future data.
-- ---------------------------------------------------------------------------

alter table paylater_customers
  add column if not exists currency text not null default 'QAR';

-- Orders carry their own, since a customer could in principle hold purchases
-- billed in two currencies; today they always match the file's.
alter table paylater_orders
  add column if not exists currency text;

comment on column paylater_customers.currency is
  'ISO code as printed on the customer report ("Total Outstanding Due <CODE>"). Defaults to QAR for rows imported from the monthly spreadsheet, which states no currency.';
