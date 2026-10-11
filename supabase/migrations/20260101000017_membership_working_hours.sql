-- ---------------------------------------------------------------------------
-- WORKING HOURS — per-employee, per-company expected schedule.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #2 (memberships) already existing.
--
-- WHAT IT DOES
--   • adds working_days / work_start_time / work_end_time to `memberships`.
--     All nullable, so every existing membership keeps working exactly as
--     before until an admin/manager sets a schedule for that person.
--
-- THE MODEL
--   • Informational only, for now: a stored schedule shown on the employee's
--     edit card. Nothing else in the app reads or enforces it yet — it's a
--     foundation for later features (e.g. attendance/lateness), not a change
--     to the existing company-wide color-engine working_days.
--   • working_days mirrors companies.working_days: an int[] of weekday
--     numbers (0=Sunday..6=Saturday).
-- ---------------------------------------------------------------------------

alter table memberships
  add column if not exists working_days integer[],
  add column if not exists work_start_time time,
  add column if not exists work_end_time time;
