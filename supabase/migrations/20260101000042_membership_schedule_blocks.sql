-- WORK SCHEDULE BLOCKS — a week described as intervals, each one office or online.
--
-- WHY THE SINGLE START/END COULD NOT HOLD IT
--   Migration #17 gave a membership one work_start_time, one work_end_time and a
--   list of working days. That describes "in the office, 09:00 to 17:00, Sunday
--   to Thursday" and nothing else. A real schedule handed to us looks like this:
--
--     Sunday     online 09:00–12:00, then office 14:30–16:30
--     Monday     office 09:00–15:00
--     Tuesday    online 09:00–12:00, then office 14:30–16:30
--     Wednesday  online 09:00–15:00
--     Thursday   office 09:00–12:00
--
--   Four things there are unrepresentable above:
--     1. THE MODE CHANGES INSIDE A DAY. Sunday is both online and office.
--     2. THE DAY IS SPLIT. Sunday has a gap from 12:00 to 14:30.
--     3. THE HOURS DIFFER BY WEEKDAY. Monday is six hours, Thursday three.
--     4. ONLINE WORK IS INVISIBLE TO THE DEVICE. The ZKTeco reader only ever
--        sees somebody physically present, so a fully-online Wednesday and a
--        no-show are the same empty row.
--
--   With one start time, that Sunday has to be recorded as starting at 09:00 —
--   so somebody correctly working online at nine and reaching the office at half
--   past two is logged five and a half hours late, every single Sunday.
--
-- WHAT A BLOCK IS
--   One weekday, one interval, one mode. A day is the blocks that cover it; time
--   no block covers is off. Lateness is measured per OFFICE block, from that
--   block's own start, and an ONLINE block is never absence-for-want-of-a-device
--   -record — the firm's rule is that online hours are worked unless a manager
--   says otherwise.
--
-- WHY THE ROWS ARE DATED
--   The schedule that prompted this runs 25 August to 1 May. Without validity
--   dates, editing somebody's hours silently re-judges every past day against
--   the new times: reopening last term's attendance would score it on this
--   term's schedule. `valid_from`/`valid_to` mean a date is always judged
--   against the schedule that was in force THEN, and next term can be entered
--   in advance instead of on the morning it starts.
--
-- NOTHING IS REMOVED. memberships.work_start_time / work_end_time / working_days
-- stay exactly as they are and remain the rule for every membership with no
-- blocks — which is everyone, until somebody is given a schedule here. See the
-- fallback in lib/platform/lateness.ts.

create table if not exists membership_schedule_blocks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid not null references app_users(id) on delete cascade,

  -- 0 = Sunday … 6 = Saturday, matching memberships.working_days and
  -- lib/platform/lateness.ts's isoDateWeekday.
  weekday     smallint not null check (weekday between 0 and 6),

  start_time  time not null,
  end_time    time not null,
  mode        text not null check (mode in ('office', 'online')),

  -- The term this block belongs to. valid_to null = open-ended.
  valid_from  date not null,
  valid_to    date,

  created_at  timestamptz not null default now(),
  created_by  uuid references app_users(id) on delete set null,

  -- An interval that ends before it starts is not a schedule, it is a typo.
  constraint membership_schedule_blocks_interval check (end_time > start_time),
  constraint membership_schedule_blocks_term
    check (valid_to is null or valid_to >= valid_from)
);

-- Every read is "this person, in this company, on this weekday, in force on
-- this date" — the attendance rule asks it once per uploaded row.
create index if not exists membership_schedule_blocks_lookup
  on membership_schedule_blocks (company_id, user_id, weekday, valid_from);

comment on table membership_schedule_blocks is
  'A week as intervals: each block is one weekday, one time range, and either office or online. Falls back to memberships.work_start_time when a membership has no blocks.';
