-- ---------------------------------------------------------------------------
-- ATTENDANCE DAY STATUS — mark a day as ABSENT or VACATION.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent. Depends on migration #20 (attendance_records).
--
-- WHAT IT DOES
--   • adds attendance_records.day_status:
--       'present'  — the normal case; lateness is measured from the person's
--                    own start time (lib/platform/lateness.ts)
--       'absent'   — did not come in. Counts as a FULL working day late
--                    (ABSENT_LATE_MINUTES = 480, i.e. 8 hours).
--       'vacation' — approved leave. Counts as ZERO, and is not lateness at all.
--
-- WHY A STATUS RATHER THAN JUST WRITING late_minutes
--   The number alone loses the reason. 480 minutes could mean "absent" or a
--   genuinely enormous late arrival, and vacation is indistinguishable from a
--   punctual day if both are simply 0. Storing WHY lets the UI colour the two
--   differently (absent red / vacation green), lets the totals explain
--   themselves, and lets the 8-hour figure be changed later without rewriting
--   history — the minutes are derived from the status at read time.
--
-- EXISTING ROWS default to 'present', so every previously uploaded day keeps
-- exactly the lateness it already had.
-- ---------------------------------------------------------------------------

alter table attendance_records
  add column if not exists day_status text not null default 'present';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'attendance_records_day_status_chk'
  ) then
    alter table attendance_records
      add constraint attendance_records_day_status_chk
      check (day_status in ('present', 'absent', 'vacation'));
  end if;
end $$;

-- The company summary filters a period and then groups by person; day_status is
-- read on every one of those rows.
create index if not exists attendance_records_day_status_idx
  on attendance_records (company_id, day_status)
  where day_status <> 'present';
