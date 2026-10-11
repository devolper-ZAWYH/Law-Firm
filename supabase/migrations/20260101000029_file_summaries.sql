-- ---------------------------------------------------------------------------
-- FILE SUMMARY — ONE standing summary per folder.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent. Depends on migration #3 (files).
--
-- WHY NOT JUST A COMMENT
--   Comments are a LOG: many entries, ordered, each frozen to its moment. A
--   summary answers a different question — "what is this matter, right now" —
--   and there is exactly one answer at a time. Hence one row per file
--   (unique on file_id), written once and edited thereafter, rather than an
--   append-only thread.
--
--   created_by/created_at record who first wrote it; updated_by/updated_at who
--   last changed it. Both are kept because "who owns this description" and
--   "who touched it last" are different questions during a handover.
-- ---------------------------------------------------------------------------

create table if not exists file_summaries (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null unique references files(id) on delete cascade,
  body        text not null,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now(),
  updated_by  uuid references app_users(id),
  updated_at  timestamptz not null default now()
);

create index if not exists file_summaries_file_idx on file_summaries (file_id);

alter table file_summaries enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
