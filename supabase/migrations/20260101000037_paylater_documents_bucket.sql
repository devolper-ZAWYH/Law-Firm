-- ---------------------------------------------------------------------------
-- PAYLATER — THE STORAGE BUCKET FOR CUSTOMER DOCUMENTS
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent (safe to re-run). Depends on #34, which created
-- paylater_documents (the rows describing what is in here).
--
-- WHY A BUCKET AND NOT THE DATABASE. The rest of the platform archives an
-- uploaded file as base64 in a column (see attendance_uploads). That is fine
-- for one spreadsheet a month. It is not fine here: a single batch of customer
-- reports and ID cards is ~59 MB across 146 PDFs, and putting that in table
-- rows would bloat every backup and every full-table read of a table the
-- portal queries constantly. The spec says Supabase Storage for exactly this,
-- and this is that bucket.
--
-- PRIVATE. `public = false`, so nothing is reachable by URL guessing. These are
-- customer ID cards and debt reports; every read goes through a route that has
-- already resolved who is asking (see /api/paylater/documents/[id]).
--
-- THE LIMITS ARE THE DATA'S. The largest customer report in Batch 7 is 740 KB
-- and the largest ID card 296 KB, so 10 MB is generous without inviting someone
-- to park a video here. The mime list is what the firm actually receives: the
-- reports are PDFs, and the ID cards arrive as PDFs or as photographs.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'paylater-documents',
  'paylater-documents',
  false,
  10485760, -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
