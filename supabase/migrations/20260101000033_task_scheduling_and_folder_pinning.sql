-- ---------------------------------------------------------------------------
-- TASK SCHEDULING (THE WORKLOAD CALENDAR) AND FOLDER PINNING
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #3 (files), #8 (tasks), #14
-- (folder_types) and #32 (due_at).
--
-- TASKS — the two facts a workload calendar needs and the row could not state
--
--   • estimated_hours — how long the work is expected to take. Until now a task
--     carried no size at all, so ten tasks on a Tuesday and one on a Wednesday
--     looked identical on any calendar, and "is this person overloaded" had no
--     answer the database could give. Nullable: an estimate is a judgement, and
--     forcing a number where nobody has one produces fiction, not data. A task
--     with no estimate contributes NOTHING to a day's load rather than a
--     guessed default that would quietly inflate every bar.
--
--   • scheduled_date — the day the work is PLANNED to be done, which is not the
--     day it is DUE. A filing due at the end of the month is worked on for two
--     days somewhere before that, and a calendar that can only place it on its
--     deadline shows a wall of work on the 30th and an empty month behind it.
--     A `date`, not a timestamptz: a plan is "Tuesday", not "Tuesday 14:32 in
--     some timezone", and storing an instant would drift a task across the
--     midnight boundary for anyone in a different offset.
--
--     NULL is the meaningful state, not a gap: an unscheduled task is exactly
--     what the calendar's "unscheduled" pile shows, and dragging one onto a day
--     is the write that fills this column in. Every task that exists today
--     starts unscheduled, which is the truth about them — nobody has planned
--     them onto a day yet.
--
-- FILES
--   • is_pinned — a folder every employee of the company can see and which
--     sorts to the front of the list. It sits alongside `is_general` (#32) as
--     the SECOND way a folder becomes visible without a per-person access
--     grant, and deliberately so: the firm has more than one folder everyone
--     needs (the general folder, the current big matter, the office manual),
--     and `is_general` cannot express that — its partial unique index allows
--     exactly one per company, by design.
--
--     Unlike `is_general` there is no uniqueness constraint here: any number of
--     folders may be pinned. Pinning is therefore a REAL widening of who can
--     see a folder's existence, which is why the API restricts the act of
--     pinning to admins and managers.
--
--   • folder_type_2 — an OPTIONAL second folder type. A matter is regularly
--     two things at once (a contract that became a case, a case with a
--     retainer attached), and forcing the single `folder_type` column to
--     choose loses the other half. A second nullable column rather than a join
--     table: two is the number people asked for and the number the folder
--     header can show, and a join table would buy open-ended cardinality
--     nothing in the UI could render.
--
--     The FIRST type still decides the folder's LAYOUT (client+opponent vs
--     client-only) — see lib/platform/folderTypes.ts. The second is a label
--     the folder also carries; letting it drive layout too would mean a folder
--     whose fields depend on the ORDER two types were picked in.
-- ---------------------------------------------------------------------------

alter table tasks add column if not exists estimated_hours numeric(6, 2);
alter table tasks add column if not exists scheduled_date  date;

-- An estimate is a positive number of hours or nothing at all. 0 would mean
-- "takes no time", which no task does, and a negative estimate would subtract
-- from a day's load — quietly making an overloaded day look free.
--
-- The upper bound is a typo guard, not a policy: 999.99 hours is already six
-- months of work on one task, so anything beyond it is a slipped decimal
-- point (a "40" typed as "4000"), and one such row would flatten every load
-- bar in the month it lands on.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_estimated_hours_positive'
  ) then
    alter table tasks add constraint tasks_estimated_hours_positive
      check (estimated_hours is null or (estimated_hours > 0 and estimated_hours <= 999.99));
  end if;
end
$$;

-- The calendar's main read is "every task planned for this month, for these
-- people", so the index leads with the day and carries the assignee.
create index if not exists tasks_scheduled_date_idx
  on tasks (scheduled_date, assignee_id);

-- The unscheduled pile is read on every visit to the calendar and is a
-- SMALL slice of a growing table, so it gets its own partial index rather
-- than scanning every task to find the ones with no plan.
create index if not exists tasks_unscheduled_idx
  on tasks (assignee_id) where scheduled_date is null;

alter table files add column if not exists is_pinned boolean not null default false;
alter table files add column if not exists folder_type_2 text;

-- The second type is validated exactly like the first: a key that exists in
-- folder_types, or nothing. Added as a named constraint so the deploy-safety
-- retry in lib/platform/files.ts sees the same failure shape it already
-- handles for folder_type.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_folder_type_2_fk'
  ) then
    alter table files
      add constraint files_folder_type_2_fk
      foreign key (folder_type_2) references folder_types(key);
  end if;
end
$$;

-- A folder must not carry the same type twice — "Case and Case" is not two
-- types, it is one type and a mistake, and the folder header would render the
-- same chip beside itself.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_folder_types_distinct'
  ) then
    alter table files add constraint files_folder_types_distinct
      check (folder_type_2 is null or folder_type_2 is distinct from folder_type);
  end if;
end
$$;

-- Pinned folders are read on every employee's folder list (they are visible
-- without an access grant), always within one company.
create index if not exists files_pinned_idx
  on files (company_id) where is_pinned;
