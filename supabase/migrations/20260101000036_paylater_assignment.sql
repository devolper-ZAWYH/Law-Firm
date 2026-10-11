-- ---------------------------------------------------------------------------
-- PAYLATER — WHO IS THE FILE ASSIGNED TO
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #34 (paylater_customers) and
-- #1 (app_users).
--
-- WHY: step 2 of the case journey is "Divide the batches among the Pay Later
-- employees according to their Team Leader", and step 7 is "the employee
-- RESPONSIBLE FOR THE RELEVANT BATCH begins sending the legal notices". The
-- portal could create batches and assign notice dates but had no way to say
-- whose files these are — so the Team Leader's actual division of work lived
-- outside the system, and no employee could ask "which files are mine?".
--
-- THIS DOES NOT REPLACE handler_name, AND THE TWO ARE NOT THE SAME THING.
--
--   handler_name  TEXT, from the source spreadsheet. The person the firm's own
--                 records say handled the file, historically. Free text on
--                 purpose: it names people who may have no portal account, and
--                 rewriting history to fit our user table would be a lie.
--
--   assigned_to   A LIVE LINK to a portal account. Who is working the file now,
--                 set by the Team Leader in the portal, and what "my files"
--                 means.
--
-- Keeping both means importing next month's spreadsheet never silently
-- reassigns live work, and assigning work never edits the historical record.
--
-- ON DELETE SET NULL, not CASCADE: removing an employee's account must not
-- delete client files. The file becomes unassigned and reappears for the Team
-- Leader to hand to someone else — which is exactly what happens in reality
-- when somebody leaves.
-- ---------------------------------------------------------------------------

alter table paylater_customers
  add column if not exists assigned_to uuid references app_users(id) on delete set null;

-- "Which of this company's files are mine?" — the employee's daily question,
-- and the Team Leader's "what is still unassigned?" (assigned_to is null).
create index if not exists paylater_customers_assigned_idx
  on paylater_customers (company_id, assigned_to);
