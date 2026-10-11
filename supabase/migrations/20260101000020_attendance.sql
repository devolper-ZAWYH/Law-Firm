-- ---------------------------------------------------------------------------
-- ATTENDANCE — ZKTeco Excel upload, per-employee-per-day late-minute log.
--
-- Applied automatically by scripts/migrate.ts on deploy — idempotent (safe to
-- re-run). Depends on migration #2 (memberships) and #16 (membership_permissions)
-- already existing.
--
-- WHAT IT DOES
--   • adds memberships.zkteco_employee_id — the ID from the ZKTeco device's
--     Excel export, mapped once per person by an admin/manager so uploaded
--     rows can be matched reliably (not by name).
--   • adds membership_permissions.can_upload_attendance — a 7th independent
--     grant (same model as the six folder permissions): lets admin/manager
--     designate ONE (or more) trusted employee(s) to upload the attendance
--     sheet, without giving them any other elevated access.
--   • creates `attendance_records` — one row per (employee, calendar day),
--     upserted from the uploaded sheet. late_minutes comes directly from the
--     sheet's own "Late In(M)" column — we don't recompute it. Clock-out /
--     overtime / early-out are intentionally NOT stored: only arrival
--     lateness matters here (per the "if the employee stays after work idc"
--     product decision).
--
-- THE MODEL
--   • "Current period" is 25th → 24th (not calendar month) — computed at
--     query time from `date`, never stored as a running counter, so it's
--     always correct for any period and re-uploads simply overwrite the
--     affected day (unique on user_id+date).
-- ---------------------------------------------------------------------------

alter table memberships
  add column if not exists zkteco_employee_id text;

-- One ZKTeco id maps to at most one person PER COMPANY (globally duplicate
-- ids across different companies' devices are fine).
create unique index if not exists memberships_company_zkteco_id_idx
  on memberships (company_id, zkteco_employee_id)
  where zkteco_employee_id is not null;

alter table membership_permissions
  add column if not exists can_upload_attendance boolean not null default false;

create table if not exists attendance_records (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_users(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  date          date not null,
  clock_in      time,
  clock_out     time,
  late_minutes  integer not null default 0,
  uploaded_by   uuid references app_users(id),
  uploaded_at   timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists attendance_records_company_date_idx
  on attendance_records (company_id, date);

alter table attendance_records enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
