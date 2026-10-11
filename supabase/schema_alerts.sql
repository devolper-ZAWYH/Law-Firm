-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 7 (Alerts + Telegram) schema
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run). It depends on Phase 1
--     (companies + app_users + memberships) and Phase 4 (tasks) already
--     existing — run the earlier migrations first.
--
-- EVERYTHING IS OPTIONAL, per company:
--   • alerts_enabled  (default TRUE)  — master switch for ALL in-app alerts
--                     (overdue warn/critical + task_done + task_sent_back).
--                     When false, nothing is ever notified for that company.
--   • telegram_enabled(default FALSE) — additionally push RED (critical) alerts
--                     to Telegram, but ONLY when the bot token + chat id are set.
--
-- DEDUP: tasks.last_alert_level (null | 'warn' | 'critical') remembers the last
--        overdue level a task fired at, so the alert engine only notifies on a
--        NEW upward transition (not on every page read). It is reset to null
--        when a task is approved/closed (so a reactivated / again-overdue task
--        can alert afresh).
--
-- notifications: one row per delivered in-app alert, addressed to a user. RLS is
--        deny-by-default (service-role only), exactly like every platform table.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Per-company optional toggles.
-- ---------------------------------------------------------------------------
alter table companies add column if not exists alerts_enabled   boolean not null default true;
alter table companies add column if not exists telegram_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Per-task alert-dedup state. null | 'warn' | 'critical'.
-- (Plain text — deliberately not an enum, so null is a clean "never alerted".)
-- ---------------------------------------------------------------------------
alter table tasks add column if not exists last_alert_level text;

-- ---------------------------------------------------------------------------
-- notifications — in-app inbox, one row per delivered alert.
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,
  type       text not null,   -- 'overdue_warn' | 'overdue_critical' | 'task_done' | 'task_sent_back'
  level      text,            -- 'warn' | 'critical' | null
  message_en text,
  message_ar text,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx on notifications (user_id, is_read);
create index if not exists notifications_created_idx      on notifications (created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-by-default, exactly like every other platform
-- table. No anon/authenticated policies on purpose: access only via the
-- service-role key, which BYPASSES RLS for trusted server code.
-- ---------------------------------------------------------------------------
alter table notifications enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
