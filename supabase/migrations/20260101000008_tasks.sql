-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 4 (Tasks) schema
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run). It depends on Phase 1
--     (companies + app_users + memberships), Phase 2 (files) and Phase 3
--     (file_access) already existing — run the earlier migrations first.
--
-- What it does:
--   • creates `tasks`       — one row per task on a file (assignee + approver).
--   • creates `task_events` — an append-only history of what happened to a task
--                             (created / marked_done / approved / sent_back /
--                             reassigned), each with the actor and an optional
--                             note (the manager's send-back reason).
--   • enables RLS deny-by-default on both (service-role only, like every table).
--
-- THE MODEL — authorization is two-layer and enforced SERVER-SIDE (auth.ts +
-- tasks.ts + the API routes). Managers OPERATE (create/assign/approve tasks);
-- Admin CONFIGURES and does NOT create tasks. A task lives on a file, whose
-- company is the hard isolation boundary.
--
-- THE TIMER — accumulated_working_seconds + last_resumed_at together track how
-- much WORKING time a task has been "running" (only seconds inside the company's
-- working_days count; see lib/platform/workingTime.ts). On create the clock
-- starts (last_resumed_at = assigned_at). Marking done FREEZES it (add the
-- elapsed working-seconds into accumulated, set last_resumed_at = null). Sending
-- back RESUMES it (last_resumed_at = now, accumulated kept). The color engine
-- (Phase 5) reads these fields — Phase 4 only maintains them correctly.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type task_status as enum ('open', 'awaiting_approval', 'approved');
  end if;
end
$$;

create table if not exists tasks (
  id                          uuid primary key default gen_random_uuid(),
  file_id                     uuid not null references files(id)     on delete cascade,
  title                       text not null,
  description                 text,
  assignee_id                 uuid not null references app_users(id),
  approver_id                 uuid not null references app_users(id),
  created_by                  uuid not null references app_users(id),
  status                      task_status not null default 'open',
  assigned_at                 timestamptz not null default now(),
  accumulated_working_seconds bigint not null default 0,
  last_resumed_at             timestamptz,               -- = assigned_at on create; null while awaiting_approval
  created_at                  timestamptz not null default now()
);

create index if not exists tasks_file_idx     on tasks (file_id);
create index if not exists tasks_assignee_idx on tasks (assignee_id);
create index if not exists tasks_approver_idx on tasks (approver_id);

-- ---------------------------------------------------------------------------
-- task_events — append-only history for each task.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_event_type') then
    create type task_event_type as enum ('created', 'marked_done', 'approved', 'sent_back', 'reassigned');
  end if;
end
$$;

create table if not exists task_events (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  type       task_event_type not null,
  actor_id   uuid not null references app_users(id),
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists task_events_task_idx on task_events (task_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default, exactly like every other platform table.
-- No anon/authenticated policies on purpose: the tables are entirely
-- inaccessible from the browser (anon key). All access is server-side with the
-- service-role key, which BYPASSES RLS for trusted server code.
-- ---------------------------------------------------------------------------
alter table tasks       enable row level security;
alter table task_events enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
