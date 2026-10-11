-- ---------------------------------------------------------------------------
-- AlBaker Law Firm — Authentication Portal
-- Database schema. Run this in the Supabase SQL Editor (or via psql using
-- DATABASE_URL) once, when setting up the project.
-- ---------------------------------------------------------------------------

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  email text unique,
  password_hash text not null,
  role text not null default 'user' check (role in ('admin','manager','user')),
  created_at timestamptz not null default now()
);

-- Enable Row Level Security. We deliberately create NO policies for the
-- anon / authenticated roles, so the table is completely inaccessible from the
-- browser (anon key). All access happens server-side with the service-role key,
-- which bypasses RLS.
alter table app_users enable row level security;

-- (No anon/authenticated policies on purpose — access only via service-role key.)

-- Helpful case-insensitive lookups for login (username or email).
create unique index if not exists app_users_username_lower_idx
  on app_users (lower(username));
create unique index if not exists app_users_email_lower_idx
  on app_users (lower(email));

-- Session revocation support (F2). token_version is embedded in the session
-- JWT at login and validated on each request; it is incremented on logout and
-- (future) password change to invalidate all outstanding tokens for a user.
-- Safe to run on an existing DB; existing rows get 0 (matching existing tokens).
alter table app_users
  add column if not exists token_version int not null default 0;

-- Index the admin users-list ordering (select ... order by created_at desc).
create index if not exists app_users_created_at_idx
  on app_users (created_at desc);

-- NOTE on auth lookups: findUserByIdentifier does exact-match .eq('username', …)
-- and .eq('email', …). Those are already served by the UNIQUE btree indexes that
-- Postgres creates automatically for the `username`/`email` unique constraints,
-- so no extra index is needed for login. (The lower(...) unique indexes above
-- enforce case-insensitive uniqueness.)
