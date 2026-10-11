-- ---------------------------------------------------------------------------
-- FILE COMMENTS — a running, timestamped comment log on each folder.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #3 (files) already existing.
--
-- WHAT IT DOES
--   • creates `file_comments` — one row per comment, always tied to a folder
--     and its author. Deleting the folder cascades (no orphaned comments).
--
-- THE MODEL
--   • The create-file form may submit an OPTIONAL first comment (posted right
--     after the folder is created, same author as the folder creator).
--   • The folder detail view shows the full log and lets anyone who can VIEW
--     the folder add another comment — same audience as the folder itself
--     (admin, manager, or an employee with any granted permission on it).
--   • Comments are never edited or deleted — an append-only log.
-- ---------------------------------------------------------------------------

create table if not exists file_comments (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null references files(id) on delete cascade,
  author_id   uuid not null references app_users(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists file_comments_file_idx on file_comments (file_id, created_at);

alter table file_comments enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
