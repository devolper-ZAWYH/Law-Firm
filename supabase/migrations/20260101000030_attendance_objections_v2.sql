-- ---------------------------------------------------------------------------
-- ATTENDANCE OBJECTIONS v2 — raised by the SHEET UPLOADER, approved by ONE
-- admin-designated manager; plus the archive of uploaded attendance files.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on #20 (attendance_records), #21 (early_out) and #22
-- (attendance_objections) already existing.
--
-- WHAT IT DOES
--   • companies.attendance_objection_approver_id — the ONE manager the admin
--     designates to receive and decide objections for that company. Null means
--     objections cannot be raised there at all (the UI says so).
--
--   • attendance_records.excused_minutes — minutes an APPROVED objection has
--     removed from that day. Its own column on purpose: late_minutes is
--     RECOMPUTED on every read from clock_in + the employee's schedule (see
--     computeLateMinutes / attendanceSummaryForCompany), so writing a reduced
--     late_minutes would simply be recomputed away on the next page load.
--     Reporting subtracts this from the day's total — late first, then
--     early-out, floored at zero.
--
--   • attendance_uploads — the archive behind the "Uploaded files" section:
--     the original workbook (base64; a time-card export is a few hundred KB,
--     so no object store is worth introducing for it) plus what it covered.
--     attendance_records.upload_id links each stored day back to the file it
--     came from, which is what makes "edit" and "delete" of a whole upload
--     possible.
--
--   • attendance_objections gains the request/decision half: how many minutes
--     are being disputed, who raised it, who must decide, and the outcome.
--     Pre-existing employee-filed rows keep status null and remain as history
--     — the employee-facing objection feature itself is removed in this
--     release.
-- ---------------------------------------------------------------------------

alter table companies
  add column if not exists attendance_objection_approver_id uuid
    references app_users(id) on delete set null;

alter table attendance_records
  add column if not exists excused_minutes integer not null default 0;

create table if not exists attendance_uploads (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  uploaded_by   uuid references app_users(id) on delete set null,
  file_name     text not null,
  file_base64   text not null,
  date_start    date,
  date_end      date,
  total_rows    integer not null default 0,
  matched_rows  integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists attendance_uploads_company_idx
  on attendance_uploads (company_id, created_at desc);

alter table attendance_records
  add column if not exists upload_id uuid
    references attendance_uploads(id) on delete set null;

create index if not exists attendance_records_upload_idx
  on attendance_records (upload_id);

alter table attendance_objections
  add column if not exists requested_minutes integer not null default 0;
alter table attendance_objections
  add column if not exists status text;
alter table attendance_objections
  add column if not exists approver_id uuid references app_users(id) on delete set null;
alter table attendance_objections
  add column if not exists raised_by uuid references app_users(id) on delete set null;
alter table attendance_objections
  add column if not exists decided_at timestamptz;
alter table attendance_objections
  add column if not exists decided_by uuid references app_users(id) on delete set null;

create index if not exists attendance_objections_pending_idx
  on attendance_objections (company_id, status);

alter table attendance_uploads enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
