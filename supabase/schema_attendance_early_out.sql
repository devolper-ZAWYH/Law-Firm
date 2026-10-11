-- ---------------------------------------------------------------------------
-- ATTENDANCE — track Early Out(M) separately from Late In(M).
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #20 (attendance_records) already existing.
--
-- WHAT IT DOES
--   • adds attendance_records.early_out_minutes, default 0. Kept as its own
--     column rather than folded into late_minutes — the product decision is
--     to show/report them separately (an employee may object to either kind
--     independently — see attendance_objections, migration #22).
-- ---------------------------------------------------------------------------

alter table attendance_records
  add column if not exists early_out_minutes integer not null default 0;
