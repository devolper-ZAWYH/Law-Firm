-- Hide a person from the Employee Tasks workload calendar.
--
-- The calendar lists the whole roster on purpose: someone with an empty week
-- has no tasks at all, and inferring the roster from the tasks would erase
-- exactly the person a manager is looking for when they ask who is free. An
-- empty load bar is the most useful row on the screen.
--
-- But not everyone in the company is someone a manager is planning work for —
-- and a roster carrying rows nobody will ever assign to makes the useful rows
-- harder to find. This flag lets a manager take one person out of that view,
-- from the employee's own card.
--
-- IT IS NOT A PERMISSION. It hides a row from one screen; it grants and revokes
-- nothing, and it does not affect what the person can see or do, whether they
-- can be assigned a task, or whether their existing tasks still count. Anything
-- to do with access lives in the capability tree instead.
--
-- Frozen accounts are excluded from that calendar too, but by their frozen
-- state and not by this column — a frozen account is already "not here", and
-- making an admin also tick this would be two places to say one thing.
--
-- Additive and idempotent, per the migration policy in scripts/migrate.ts:
-- default false, so every existing membership keeps appearing exactly as it
-- does today and nothing has to be backfilled.

alter table memberships
  add column if not exists hidden_from_workload boolean not null default false;

comment on column memberships.hidden_from_workload is
  'True = omit this person from the Employee Tasks workload calendar. A display preference, not a permission.';
