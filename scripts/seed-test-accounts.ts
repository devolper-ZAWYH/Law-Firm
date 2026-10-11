/**
 * Seed THREE test accounts — one admin, one manager, one employee — for
 * exercising the platform end to end.
 *
 * Usage:
 *   npm run seed:test
 *
 * ⚠️  THIS WRITES REAL ACCOUNTS TO WHATEVER DATABASE YOUR ENV POINTS AT.
 *     There is no separate "test mode": the portal has one database, and a
 *     manager account created here can see that company's folders exactly as
 *     any other manager can. Point it at a scratch Supabase project if you have
 *     one. If you point it at production, delete the three accounts afterwards
 *     (see "Cleaning up" at the bottom of this file).
 *
 * WHAT IT CREATES
 *   • test-admin    — is_admin, the master key over every company.
 *   • test-manager  — a `manager` MEMBERSHIP in one company.
 *   • test-employee — an `employee` MEMBERSHIP in the same company.
 *
 * A person does not have a single role on this platform: an admin is a global
 * boolean, and manager/employee are memberships in a specific company (see
 * supabase/schema_platform.sql). So the manager and employee are only
 * meaningful relative to a company, which is why one has to be chosen below.
 *
 * WHICH COMPANY
 *   $SEED_TEST_COMPANY, matched against companies.name_en, or the OLDEST
 *   company if unset. It never CREATES a company: a stray half-configured
 *   company left behind in a live portal is worse than this script refusing to
 *   run, and companies carry working-day and colour-ladder settings that ought
 *   to be chosen deliberately.
 *
 * WORKING HOURS
 *   The manager and employee are given a 09:00–13:00, Sunday–Thursday schedule.
 *   That is not decoration: the Employee Tasks calendar derives each person's
 *   DAILY CAPACITY from exactly these columns (lib/platform/workload.ts), so
 *   without them both would fall back to the 8-hour default and the load bars
 *   would not exercise the real path. Four hours also matches the "/4h" in the
 *   design this was built to.
 *
 * USERNAME IS THE EMAIL, and that is not cosmetic.
 *
 * The employee edit card keeps the two identical: saving it sets
 * username = email (see the employees PATCH route). So a seeded account whose
 * username differed from its email was renamed the first time an admin touched
 * it, and the login printed below silently stopped working — which is exactly
 * what happened. Seeding them equal means an admin save is a no-op on the
 * identity, and the credentials here stay true.
 *
 * Upserting on EMAIL rather than username for the same reason: the email is
 * the stable identity, and a row already renamed by the UI still matches.
 *
 * PASSWORDS
 *   Generated here with crypto.randomBytes and printed ONCE. They are not
 *   stored anywhere but the bcrypt hash in the database — if you lose the
 *   output, re-run the script and it will set new ones. Set $SEED_TEST_PASSWORD
 *   to use one you choose instead (≥ 12 characters).
 *
 * Re-running is safe and CONVERGES: accounts are upserted by email, the
 * membership is set on the chosen company, and any membership these three hold
 * in a DIFFERENT company is removed. Without that last step a second run
 * against another $SEED_TEST_COMPANY left them in two companies at once, which
 * puts a switcher in their sidebar and makes "what can this employee see"
 * depend on the order the script was run in.
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

// Mirror Next.js's env precedence, exactly as scripts/seed.ts and
// scripts/migrate.ts do — so a configured local dev database wins over
// .env.local's production one rather than being quietly ignored.
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

/** 0=Sunday … 6=Saturday. The Gulf working week, matching companies' default. */
const WORKING_DAYS = [0, 1, 2, 3, 4];
const WORK_START = '09:00';
const WORK_END = '13:00';

interface SeedAccount {
  username: string;
  email: string;
  fullNameEn: string;
  fullNameAr: string;
  /** Global admin flag. Mutually exclusive with `membership` in practice. */
  isAdmin: boolean;
  /** Legacy app_users.role — kept in sync so the existing login path works. */
  legacyRole: 'admin' | 'manager' | 'user';
  /** The membership to grant in the chosen company, or null for the admin. */
  membership: 'manager' | 'employee' | null;
}

const ACCOUNTS: SeedAccount[] = [
  {
    username: 'test-admin@albaker.io',
    email: 'test-admin@albaker.io',
    fullNameEn: 'Test Admin',
    fullNameAr: 'مدير النظام التجريبي',
    isAdmin: true,
    legacyRole: 'admin',
    // No membership: an admin reaches every company through is_admin. Giving
    // one would test a different thing (an admin who is ALSO a member) and
    // hide whether the global path works on its own.
    membership: null,
  },
  {
    username: 'test-manager@albaker.io',
    email: 'test-manager@albaker.io',
    fullNameEn: 'Test Manager',
    fullNameAr: 'مدير تجريبي',
    isAdmin: false,
    legacyRole: 'manager',
    membership: 'manager',
  },
  {
    username: 'test-employee@albaker.io',
    email: 'test-employee@albaker.io',
    fullNameEn: 'Test Employee',
    fullNameAr: 'موظف تجريبي',
    isAdmin: false,
    legacyRole: 'user',
    membership: 'employee',
  },
];

/**
 * A password that is strong without being unreadable over someone's shoulder.
 * base64url of 18 random bytes ≈ 24 characters, no padding, no characters a
 * shell would need escaping for.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/** The company the two memberships attach to. Never created — see the header. */
async function resolveCompany(
  supabase: SupabaseClient
): Promise<{ id: string; nameEn: string }> {
  const wanted = process.env.SEED_TEST_COMPANY?.trim();

  const query = supabase.from('companies').select('id, name_en');
  const res = wanted
    ? await query.eq('name_en', wanted).maybeSingle()
    : await query.order('created_at', { ascending: true }).limit(1).maybeSingle();

  if (res.error) {
    throw new Error(`Could not read companies: ${res.error.message}`);
  }
  const row = res.data as { id: string; name_en: string } | null;
  if (!row) {
    throw new Error(
      wanted
        ? `No company named "${wanted}". Check companies.name_en, or unset SEED_TEST_COMPANY to use the oldest company.`
        : 'This database has no companies, so a manager or employee membership has nothing to attach to. Create a company first (supabase/seed_platform.sql seeds three).'
    );
  }
  return { id: row.id, nameEn: row.name_en };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.'
    );
    process.exit(1);
  }

  const chosenPassword = process.env.SEED_TEST_PASSWORD;
  if (chosenPassword !== undefined && chosenPassword.length < 12) {
    console.error('SEED_TEST_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const company = await resolveCompany(supabase);
  console.log(`Company for the two memberships: ${company.nameEn}\n`);

  const created: { username: string; password: string; role: string }[] = [];

  for (const account of ACCOUNTS) {
    const password = chosenPassword ?? generatePassword();
    // Cost 12, matching scripts/seed.ts — the hash is the only form of the
    // password that reaches the database.
    const passwordHash = await bcrypt.hash(password, 12);

    const userRes = await supabase
      .from('app_users')
      .upsert(
        {
          username: account.username,
          email: account.email,
          password_hash: passwordHash,
          role: account.legacyRole,
          is_admin: account.isAdmin,
          full_name_en: account.fullNameEn,
          full_name_ar: account.fullNameAr,
        },
        { onConflict: 'email' }
      )
      .select('id, username')
      .single();

    if (userRes.error) {
      throw new Error(
        `Could not seed ${account.username}: ${userRes.error.message}`
      );
    }
    const userId = (userRes.data as { id: string }).id;

    if (account.membership) {
      // These are dedicated test accounts, so they belong to exactly ONE
      // company — the chosen one. Any membership elsewhere is left over from a
      // previous run against a different $SEED_TEST_COMPANY, and leaving it
      // would quietly give the account a second company in the switcher and
      // make "what can this employee see" depend on run history. Scoped to the
      // seeded accounts; no other membership is ever touched.
      const stale = await supabase
        .from('memberships')
        .delete()
        .eq('user_id', userId)
        .neq('company_id', company.id)
        .select('company_id');
      if (stale.error) throw new Error(stale.error.message);
      const dropped = ((stale.data as { company_id: string }[] | null) ?? []).length;
      if (dropped > 0) {
        console.log(
          `  (${account.username}: removed ${dropped} membership(s) in other companies)`
        );
      }

      const memRes = await supabase.from('memberships').upsert(
        {
          user_id: userId,
          company_id: company.id,
          role: account.membership,
          // The columns the calendar derives daily capacity from. Without
          // these both people fall back to the 8-hour default and the load
          // bars never exercise the configured path.
          working_days: WORKING_DAYS,
          work_start_time: WORK_START,
          work_end_time: WORK_END,
        },
        { onConflict: 'user_id,company_id' }
      );
      if (memRes.error) {
        throw new Error(
          `Could not grant ${account.username} a ${account.membership} membership: ${memRes.error.message}`
        );
      }
    }

    created.push({
      username: account.username,
      password,
      role: account.isAdmin
        ? 'global admin'
        : `${account.membership} in ${company.nameEn}`,
    });
  }

  console.log('Seeded three accounts. The passwords are shown ONCE:\n');
  for (const row of created) {
    console.log(`  ${row.username.padEnd(15)} ${row.password}`);
    console.log(`  ${''.padEnd(15)} ${row.role}\n`);
  }
  console.log(
    `Both memberships work ${WORK_START}–${WORK_END} on Sun–Thu, so the Employee\n` +
      'Tasks calendar draws their load bars against a 4-hour day.\n'
  );
  console.log(
    'CLEANING UP. Delete the rows when you are done — a live portal should not\n' +
      'keep test accounts. In the Supabase SQL editor:\n\n' +
      "  delete from app_users where email like 'test-%@albaker.io';\n\n" +
      'Memberships cascade with the user, so that one statement is enough.'
  );
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
