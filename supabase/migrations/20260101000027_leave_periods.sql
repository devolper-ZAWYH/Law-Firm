-- ---------------------------------------------------------------------------
-- LEAVE PERIODS — forward-looking booked leave for an employee.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent. Depends on migration #20 (attendance_records) and #2 (memberships).
--
-- WHY THIS EXISTS ALONGSIDE attendance_records.day_status='vacation'
--   day_status is RETROSPECTIVE: the uploader marks a day on a sheet that has
--   already been produced. It cannot answer "is Ahmed away next Tuesday", which
--   is what task assignment needs. A leave period is the forward-looking record;
--   creating one WRITES DOWN into day_status so the two never disagree.
--
-- WHOLE DAYS ONLY. end_date is INCLUSIVE — a one-day leave has start = end.
-- ---------------------------------------------------------------------------

create table if not exists leave_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  note        text,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now()
);

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'leave_periods_range_chk'
  ) then
    alter table leave_periods
      add constraint leave_periods_range_chk check (end_date >= start_date);
  end if;
end $$;

-- "who is on leave on date D" filters company + straddles the range.
create index if not exists leave_periods_company_range_idx
  on leave_periods (company_id, start_date, end_date);

create index if not exists leave_periods_user_idx
  on leave_periods (user_id, start_date);

alter table leave_periods enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
