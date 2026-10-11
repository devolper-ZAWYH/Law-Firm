-- ---------------------------------------------------------------------------
-- Multi-Company File Management Platform — PHASE 1 seed data
--
-- ⚠️  OPERATOR ACTION REQUIRED: Run schema_platform.sql FIRST, then run this
--     file ONCE in the Supabase SQL Editor. It is idempotent (safe to re-run).
--
-- What it seeds:
--   • 3 companies (Ali AlBaker Law Firm, Finjan Investment, Zawyh)
--   • the people, keyed by a UNIQUE synthetic email (NEVER by display name —
--     there are two "Aya" and three "Ahmed"; the email tag disambiguates)
--   • each person's membership(s)
--   • designates the EXISTING admin account as Yousef: is_admin=true, full
--     names, and manager memberships in all 3 companies.
--
-- ── Login note ──────────────────────────────────────────────────────────────
-- Phase-1 login focus is Yousef only. Non-Yousef users are created with a
-- PLACEHOLDER password_hash that matches NO password — they cannot log in yet.
-- They will be given real credentials in a later phase.
--
-- ── Yousef note ─────────────────────────────────────────────────────────────
-- This script does NOT create Yousef. It finds the existing admin row (by email
-- yp@albaker.qa, falling back to the oldest role='admin' row) and upgrades it in
-- place, so the CURRENT login stays as Yousef. If your admin email differs,
-- edit the lookup email below before running.
-- ---------------------------------------------------------------------------

do $$
declare
  c1 uuid;  -- Ali AlBaker Law Firm
  c2 uuid;  -- Finjan Investment
  c3 uuid;  -- Zawyh
  yousef_id uuid;
  uid uuid;
  cid uuid;
  rec record;
  -- Not a valid bcrypt hash → bcryptjs comparison always fails → no login.
  placeholder_hash constant text :=
    'PLACEHOLDER_NO_LOGIN__set_a_real_password_in_a_later_phase';
begin
  ------------------------------------------------------------------------------
  -- Companies (insert-if-missing so re-runs don't duplicate)
  ------------------------------------------------------------------------------
  insert into companies (name_en, name_ar)
    select 'Ali AlBaker Law Firm', 'مكتب علي الباكر للمحاماة'
    where not exists (select 1 from companies where name_en = 'Ali AlBaker Law Firm');
  insert into companies (name_en, name_ar)
    select 'Finjan Investment', 'فِنجان للاستثمار'
    where not exists (select 1 from companies where name_en = 'Finjan Investment');
  insert into companies (name_en, name_ar)
    select 'Zawyh', 'زاوية'
    where not exists (select 1 from companies where name_en = 'Zawyh');

  select id into c1 from companies where name_en = 'Ali AlBaker Law Firm';
  select id into c2 from companies where name_en = 'Finjan Investment';
  select id into c3 from companies where name_en = 'Zawyh';

  ------------------------------------------------------------------------------
  -- People + memberships.
  -- company_key: C1=AlBaker, C2=Finjan, C3=Zawyh. role: manager|employee.
  -- Legacy app_users.role is set to 'user' for everyone here — it is NOT used by
  -- the new authorization model (which reads is_admin + memberships).
  ------------------------------------------------------------------------------
  for rec in
    select * from (values
      -- Managers (non-admin) — one per company
      ('ali@albaker.io',      'Ali',       'علي',      'C1', 'manager'),
      ('abdulla@albaker.io',  'Abdulla',   'عبدالله',  'C2', 'manager'),
      ('muneera@albaker.io',  'Muneera',   'منيرة',    'C3', 'manager'),

      -- Ali AlBaker Law Firm employees
      ('essam@albaker.io',    'Essam',     'عصام',     'C1', 'employee'),
      ('ahmed.g@albaker.io',  'Ahmed G',   'أحمد ج',   'C1', 'employee'),
      ('sayid@albaker.io',    'Sayid',     'سيد',      'C1', 'employee'),
      ('radwa@albaker.io',    'Radwa',     'رضوى',     'C1', 'employee'),
      ('randa@albaker.io',    'Randa',     'رندة',     'C1', 'employee'),
      ('jassim@albaker.io',   'Jassim',    'جاسم',     'C1', 'employee'),
      ('jumanh@albaker.io',   'Jumanh',    'جمانة',    'C1', 'employee'),
      ('ahmed.aa@albaker.io', 'Ahmed AA',  'أحمد ع',   'C1', 'employee'),

      -- Finjan Investment employees
      ('aya@albaker.io',      'Aya',       'آية',      'C2', 'employee'),
      ('ahmed.ab@albaker.io', 'Ahmed AB',  'أحمد ب',   'C2', 'employee'),
      ('maryam@albaker.io',   'Maryam',    'مريم',     'C2', 'employee'),
      ('mustafa@albaker.io',  'Mustafa',   'مصطفى',    'C2', 'employee'),

      -- Zawyh employees
      ('adnan@albaker.io',    'Adnan',     'عدنان',    'C3', 'employee'),
      ('aya.a@albaker.io',    'Aya A',     'آية أ',    'C3', 'employee')
    ) as t(email, en, ar, company_key, role)
  loop
    -- Upsert the person by email (username = email, matching the app convention).
    insert into app_users (username, email, password_hash, role, is_admin, full_name_en, full_name_ar)
      values (rec.email, rec.email, placeholder_hash, 'user', false, rec.en, rec.ar)
      on conflict (email) do update
        set full_name_en = excluded.full_name_en,
            full_name_ar = excluded.full_name_ar
      returning id into uid;

    cid := case rec.company_key
             when 'C1' then c1
             when 'C2' then c2
             when 'C3' then c3
           end;

    insert into memberships (user_id, company_id, role)
      values (uid, cid, rec.role::membership_role)
      on conflict (user_id, company_id) do nothing;
  end loop;

  ------------------------------------------------------------------------------
  -- Yousef — the EXISTING admin account (keeps the current login working).
  ------------------------------------------------------------------------------
  select id into yousef_id from app_users where lower(email) = lower('yp@albaker.qa') limit 1;
  if yousef_id is null then
    -- Fallback: the oldest existing global admin row.
    select id into yousef_id from app_users where role = 'admin' order by created_at asc limit 1;
  end if;
  if yousef_id is null then
    raise exception
      'Seed: no existing admin account found (looked for email yp@albaker.qa, then role=admin). Create/seed the admin first, then re-run.';
  end if;

  update app_users
    set is_admin     = true,
        full_name_en = 'Yousef AlBaker',
        full_name_ar = 'يوسف الباكر'
    where id = yousef_id;

  insert into memberships (user_id, company_id, role) values
    (yousef_id, c1, 'manager'),
    (yousef_id, c2, 'manager'),
    (yousef_id, c3, 'manager')
    on conflict (user_id, company_id) do nothing;

  raise notice 'Phase-1 seed complete. Yousef id = %', yousef_id;
end
$$;
