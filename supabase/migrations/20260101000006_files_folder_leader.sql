-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — FILES: Folder leader = company member
--
-- ⚠️  OPERATOR ACTION REQUIRED: This migration is NOT applied automatically.
--     Run this whole file ONCE in the Supabase SQL Editor (or via psql using
--     DATABASE_URL). It is idempotent (safe to re-run).
--
-- What it does:
--   • adds `files.folder_leader_id` — a nullable FK into app_users(id). The
--     folder leader is now CHOSEN from the active company's members (no free
--     typing), mirroring how the client is chosen from CRM contacts.
--     ON DELETE SET NULL so removing a user never deletes a folder; the folder
--     falls back to its legacy `files.managing_lawyer` text.
--   • adds an index on the new FK for join/resolve lookups.
--
-- The legacy `files.managing_lawyer` column is KEPT and stays NOT NULL. The API
-- always writes it = the selected member's display name (name_ar||name_en||email),
-- so older / non-joined reads keep working while the UI resolves the
-- current-language folder-leader name from the joined app_users row.
-- ---------------------------------------------------------------------------

alter table files
  add column if not exists folder_leader_id uuid references app_users(id) on delete set null;

-- Helpful when resolving a folder's leader by its linked user.
create index if not exists idx_files_folder_leader_id on files (folder_leader_id);
