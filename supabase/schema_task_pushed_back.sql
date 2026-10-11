-- ---------------------------------------------------------------------------
-- TASK PUSH-BACK — a manager rewinds a task's colour by one step.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent. Depends on migration #8 (tasks + task_events).
--
-- WHAT IT DOES
--   Adds 'pushed_back' to the task_event_type enum, so the rewind is recorded
--   in task_events like every other transition.
--
-- WHY THE EVENT MATTERS MORE THAN USUAL
--   A folder's colour is DERIVED from how much working time its open tasks have
--   accrued (lib/platform/colorEngine.ts) — nothing stores "this task is red".
--   Pushing back therefore works by rewinding the task's own clock, which means
--   a folder can visibly move from red to orange with no other trace. Without
--   this event nobody could answer "why did that go back?". The event's `note`
--   carries the granted number of working days.
--
-- ENUM VALUES CANNOT BE DROPPED in Postgres, and ADD VALUE is not transactional
-- on older versions — hence its own migration, guarded so a re-run is a no-op.
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'task_event_type' and e.enumlabel = 'pushed_back'
  ) then
    alter type task_event_type add value 'pushed_back';
  end if;
end $$;
