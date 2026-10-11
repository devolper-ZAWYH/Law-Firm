-- ---------------------------------------------------------------------------
-- ACCOUNT FREEZE — suspend a person's access without deleting anything.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent, like every migration after the #1-#12 baseline.
--
-- WHAT IT DOES
--   • adds app_users.is_frozen — when true the account cannot sign in, and any
--     session it already holds stops working on the next request.
--
-- WHY ON app_users AND NOT ON memberships
--   Signing in is an ACCOUNT-level act: there is one password and one session
--   cookie per person, not one per company. A per-membership flag could not
--   answer "may this person log in?" without first choosing a company, which
--   the login screen has no way to do. Removing someone from a single company
--   is what DELETE /api/companies/:id/employees/:userId already does.
--
-- HOW THE "KICKED OUT RIGHT AWAY" PART WORKS
--   Freezing also bumps app_users.token_version, which invalidates every
--   session JWT already issued to that person (see lib/tokenVersion.ts). The
--   flag itself is additionally checked when a request resolves its platform
--   user, so a freeze still takes effect even if that bump failed.
--
--   No data is removed: their folders, tasks, comments and history are all
--   untouched, and clearing the flag restores access exactly as it was.
-- ---------------------------------------------------------------------------

alter table app_users
  add column if not exists is_frozen boolean not null default false;

-- The login path filters on it, and the employees list reads it per person.
create index if not exists app_users_is_frozen_idx
  on app_users (is_frozen)
  where is_frozen = true;
