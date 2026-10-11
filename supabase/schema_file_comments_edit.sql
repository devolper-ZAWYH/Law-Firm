-- ---------------------------------------------------------------------------
-- FILE COMMENTS — allow editing (adds an "edited" marker).
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #18 (file_comments) already existing.
--
-- WHAT IT DOES
--   • adds file_comments.edited_at, nullable. Null means never edited; set to
--     now() whenever the author edits their comment's body.
--
-- THE MODEL
--   • Only the comment's OWN author may edit it (enforced server-side).
--   • No edit history is kept — the previous body is simply overwritten; the
--     UI shows a plain "(edited)" marker next to the timestamp when
--     edited_at is set.
-- ---------------------------------------------------------------------------

alter table file_comments
  add column if not exists edited_at timestamptz;
