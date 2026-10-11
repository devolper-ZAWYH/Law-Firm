-- ---------------------------------------------------------------------------
-- PAYLATER ROLE — ONE PER PERSON, ON THE MEMBERSHIP
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #2 (memberships) and #34 (PayLater).
--
-- WHY THIS EXISTS, AND WHY #34 GOT IT WRONG
--
-- #34 shipped the four PayLater roles as four CAPABILITY KEYS, rendered as four
-- independent checkboxes in the Employees → Permissions card. That was a
-- modelling error, and the UI made it visible: nothing stopped one person being
-- ticked as both Lawyer and Auditor.
--
-- Those two are not additive permissions that happen to be held together. In
-- the case journey the Lawyer STAMPS AND SIGNS the notice and the Auditor
-- AUDITS AND PRINTS the legal memo — they are two people checking each other.
-- A person holding both collapses a review step into a self-review, and the
-- system would have no way to tell that had happened.
--
-- The capability tree cannot express "exactly one of these four". It is built
-- for additive grants: expandCapabilities deliberately expands in both
-- directions (see the note at the top of capabilities.ts), so ANY grouping of
-- these keys either implies all four or implies a parent nobody granted.
-- Exclusivity has to live somewhere the tree cannot reach.
--
-- So the role moves OUT of the capability system and onto the membership, as a
-- single-valued column. A column holds one value; holding two is not something
-- the UI has to prevent, because it is not expressible.
--
-- SCOPED PER MEMBERSHIP, not per user: memberships are already (user, company),
-- so this is automatically per-company, and PayLater is scoped to one company.
--
-- NULL means "no PayLater role", which is every existing row and the default.
-- Admins and managers still reach PayLater by ROLE and need no value here —
-- see paylaterAccess() in lib/platform/paylater.ts.
--
-- THE CHECK CONSTRAINT is a closed list on purpose, unlike `stage` and `bucket`
-- in #34. Those are read from a source document that can legitimately contain a
-- value this code has not seen. This is not: it is written only by our own
-- dropdown, from a list defined in lib/platform/paylaterRoles.ts. A typo here
-- should be refused by the database, not stored and silently ignored at
-- read time. Adding a fifth role later is a one-line widening of this
-- constraint, which scripts/migrate.ts explicitly allows.
--
-- NOTHING TO BACK-FILL. The four capability keys were live only briefly and
-- carry no production grants; any that did exist become inert on their own,
-- because isCapabilityKey() rejects a key that is no longer in the tree (the
-- same way 'notifications.attendanceObjections' was retired). The cleanup below
-- removes them anyway so a stale row cannot confuse a permissions audit.
-- ---------------------------------------------------------------------------

alter table memberships add column if not exists paylater_role text;

-- One of the four roles from the case journey, or nothing at all.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memberships_paylater_role_valid'
  ) then
    alter table memberships add constraint memberships_paylater_role_valid
      check (
        paylater_role is null
        or paylater_role in ('team_leader', 'employee', 'lawyer', 'auditor')
      );
  end if;
end
$$;

-- Only a handful of rows will ever be non-null, so index just those.
create index if not exists memberships_paylater_role_idx
  on memberships (company_id, paylater_role)
  where paylater_role is not null;

-- Retire the four capability keys #34 introduced. They are no longer in
-- CAPABILITY_TREE, so they already expand to nothing; this stops them showing
-- up in a raw query of who-was-granted-what.
delete from membership_capability_grants
  where capability_key like 'paylater.%';
