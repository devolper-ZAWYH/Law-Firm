-- ---------------------------------------------------------------------------
-- CASE DETAILS, THE GENERAL FOLDER, AND TASK SCHEDULING
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #3 (files) and #8 (tasks).
--
-- FILES
--   • case_number / court / case_level — the three facts a litigator asks for
--     first and the folder could not record. Free TEXT, not enums: court names
--     and instance levels differ per jurisdiction, and a closed list that does
--     not contain the right value is worse than a field someone can type into.
--     The UI offers the common values as suggestions without refusing others.
--
--   • is_general — marks the ONE company-wide folder every employee can see
--     without an explicit file_access row. The partial unique index below is
--     what actually enforces "one per company": doing it in the database means
--     a second general folder cannot appear through a race, a direct SQL edit,
--     or a code path that forgets to check.
--
-- TASKS
--   • due_at — when the work is actually due. Until now a task had only
--     assigned_at, so "deadline after 3 months" could not be expressed and a
--     calendar had no date to place a task on.
--
--   • repeat_every_days — a recurring follow-up ("once a month" = 30). When a
--     task carrying this is APPROVED, the next occurrence is created from it.
--     Null means it happens once, which is what every existing task is.
--
--   • excluded_from_color — a task that must NOT drive its folder's colour.
--     The colour ladder exists to make neglected work visible, but a reminder
--     deliberately set for months out is not neglected, and letting it march a
--     folder to red would train people to ignore the colour that matters.
-- ---------------------------------------------------------------------------

alter table files add column if not exists case_number text;
alter table files add column if not exists court       text;
alter table files add column if not exists case_level  text;
alter table files add column if not exists is_general  boolean not null default false;

-- At most ONE general folder per company, enforced by the database itself.
create unique index if not exists files_one_general_per_company
  on files (company_id) where is_general;

alter table tasks add column if not exists due_at              timestamptz;
alter table tasks add column if not exists repeat_every_days   integer;
alter table tasks add column if not exists excluded_from_color boolean not null default false;

-- A repeat interval is a positive number of days or nothing at all; 0 or a
-- negative value would mean "recur instantly", which is a loop.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_repeat_every_days_positive'
  ) then
    alter table tasks add constraint tasks_repeat_every_days_positive
      check (repeat_every_days is null or repeat_every_days > 0);
  end if;
end
$$;

create index if not exists tasks_due_idx on tasks (due_at);
