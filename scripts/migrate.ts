/**
 * Apply pending SQL migrations from supabase/migrations/*.sql, in filename
 * order, tracking what's already been applied in a `_migrations` table.
 *
 * Runs automatically on every deploy (see railway.json: `migrate && start`),
 * so pushing to the repo applies DB changes without a manual SQL-editor step.
 *
 * Every migration file MUST be additive-only (create table if not exists, add
 * column if not exists ... default ..., widen a check constraint) — never
 * drop/delete/alter in a way that could discard or reinterpret existing rows.
 * Each file runs inside its own transaction, so a failure rolls back that file
 * completely: the database is always at some whole number of migrations, never
 * part-way through one.
 *
 * FAILURE POLICY — LOG AND CONTINUE (this exits 0 even when it fails).
 *
 * This step used to abort the process on any failure, and railway.json chains
 * it as `migrate && start`, so ANY problem here — including simply not being
 * able to REACH the database — stopped the web server from booting at all. A
 * migration that could not run took the entire site down with it, which is a
 * far worse outcome than the schema being one migration behind: the app's data
 * layer already tolerates a missing table or column (see the "DEPLOY SAFETY"
 * guards in lib/platform/*.ts), because that is exactly the state it is in
 * during every normal deploy, between the new code starting and the migration
 * landing.
 *
 * So a failure is now reported as loudly as this medium allows and the process
 * exits 0, letting the server start. TWO THINGS STILL HOLD:
 *
 *   • A failing file is rolled back, and NO LATER FILE IS ATTEMPTED. Migrations
 *     routinely depend on the ones before them, so continuing past a failure
 *     would turn one clear error into a cascade of confusing ones. The run
 *     stops at the first failure; the app boots on the schema it has.
 *   • Nothing is recorded as applied unless it actually committed, so the next
 *     deploy retries from exactly the file that failed.
 *
 * Set MIGRATE_STRICT=1 to restore the old behaviour (exit 1 on any failure,
 * which makes `migrate && start` block the boot again). Worth doing anywhere a
 * half-current schema is worse than downtime.
 *
 * Usage: npm run migrate (reads DATABASE_URL from the environment).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from 'dotenv';

// Mirror Next.js's env precedence for `next dev`: .env.development.local wins
// over .env.local wins over .env (dotenv's first config() call for a given
// key wins, later calls don't override already-set vars).
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/** Restore the old "abort the deploy on any failure" behaviour. */
export function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MIGRATE_STRICT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Report a failure in a way that survives a wall of deploy output. Railway's
 * log view is a firehose, and the whole point of continuing past a failure is
 * that someone still has to notice it — so this is deliberately shouty and
 * greppable ("MIGRATION PROBLEM").
 */
export function reportFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error('='.repeat(72));
  console.error('MIGRATION PROBLEM — the database was NOT fully migrated.');
  console.error(`  ${what}`);
  console.error(`  ${detail}`);
  console.error('');
  console.error('  The app is starting anyway, on whatever schema the database');
  console.error('  currently has. Features needing the missing migration will');
  console.error('  behave as they did before it (see the DEPLOY SAFETY guards');
  console.error('  in lib/platform/). Fix the cause and redeploy — the next run');
  console.error('  retries from exactly the file that failed.');
  console.error('');
  console.error('  Set MIGRATE_STRICT=1 to make this abort the deploy instead.');
  console.error('='.repeat(72));
  console.error('');
}

/**
 * Migrations #1–12 mirror the already-committed supabase/schema_*.sql files,
 * which were run against production manually (per their own "OPERATOR ACTION
 * REQUIRED" comments) before this automated runner existed. They are recorded
 * as already-applied — NEVER executed — the first time this script runs
 * against a database, so this rollout doesn't replay that history. Every
 * migration filename added after this baseline runs normally.
 */
const BASELINE_FILES = [
  '20260101000001_base_app_users.sql',
  '20260101000002_platform.sql',
  '20260101000003_files.sql',
  '20260101000004_files_type.sql',
  '20260101000005_files_client_opponent.sql',
  '20260101000006_files_folder_leader.sql',
  '20260101000007_access.sql',
  '20260101000008_tasks.sql',
  '20260101000009_alerts.sql',
  '20260101000010_contacts.sql',
  '20260101000011_contacts_bilingual.sql',
  '20260101000012_seed_platform.sql',
];

export interface MigrateResult {
  /** False when something stopped the run short of applying every pending file. */
  ok: boolean;
  /** How many files actually committed. */
  ran: number;
}

/**
 * The exit code this process should use — i.e. whether `migrate && start` in
 * railway.json goes on to start the server.
 *
 * Kept as its own pure function because it IS the policy this script exists to
 * express, and it is the one thing that must not drift by accident.
 */
export function exitCodeFor(
  result: MigrateResult,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (result.ok) return 0;
  return isStrict(env) ? 1 : 0;
}

export async function main(): Promise<MigrateResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Not a crash: the web server does not need DATABASE_URL at all (it talks
    // to Supabase over REST with SUPABASE_URL + the service-role key), so an
    // unset value here must not be allowed to stop it booting.
    reportFailure(
      'DATABASE_URL is not set, so no migration could even be attempted.',
      new Error('Set DATABASE_URL in the environment to apply migrations.')
    );
    return { ok: false as const, ran: 0 };
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      create table if not exists _migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{ filename: string }>(
      'select filename from _migrations'
    );
    const applied = new Set(rows.map((r) => r.filename));

    // First run ever against this database: only baseline (skip) #1–12 if this
    // database ALREADY has the pre-automation schema (i.e. app_users exists —
    // production, migrated manually in the past). A genuinely fresh database
    // (a new dev/staging Supabase project with no tables yet) has no such
    // history to skip — it needs #1–12 to actually run and build the schema.
    if (applied.size === 0) {
      const { rows: existing } = await client.query<{ exists: boolean }>(`
        select exists (
          select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'app_users'
        ) as exists;
      `);
      const hasPreAutomationSchema = existing[0]?.exists === true;

      if (hasPreAutomationSchema) {
        for (const filename of BASELINE_FILES) {
          await client.query(
            'insert into _migrations (filename) values ($1) on conflict do nothing',
            [filename]
          );
          applied.add(filename);
        }
        console.log(
          `Baselined ${BASELINE_FILES.length} pre-existing migration(s) as already applied.`
        );
      } else {
        console.log(
          'Fresh database detected (no app_users table) — running every migration from #1.'
        );
      }
    }

    let ranCount = 0;
    for (const filename of files) {
      if (applied.has(filename)) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      console.log(`Applying migration: ${filename}`);

      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(
          'insert into _migrations (filename) values ($1)',
          [filename]
        );
        await client.query('commit');
        ranCount += 1;
      } catch (err) {
        // Roll back so the database sits at a whole number of migrations, then
        // STOP: later files routinely build on this one, and attempting them
        // would turn a single clear error into a cascade of derived ones.
        await client.query('rollback').catch(() => undefined);
        reportFailure(`Migration failed and was rolled back: ${filename}`, err);
        console.error(
          `Not attempting the ${files.filter((f) => !applied.has(f)).length - 1} later migration(s) — they may depend on this one.`
        );
        return { ok: false as const, ran: ranCount };
      }
    }

    console.log(
      ranCount === 0
        ? 'No pending migrations.'
        : `Applied ${ranCount} migration(s).`
    );
    return { ok: true as const, ran: ranCount };
  } finally {
    await client.end();
  }
}

/**
 * Guarded so a test can import this module for its exported pieces without the
 * migration actually running. Vitest sets VITEST in the environment.
 */
if (!process.env.VITEST) {
  main()
    .catch((err): MigrateResult => {
      // Everything that escapes main() lands here — most importantly a failure
      // to CONNECT at all (bad credentials, unreachable host), which is the
      // case that has nothing to do with any particular migration and used to
      // take the whole site down.
      reportFailure('Could not run migrations.', err);
      return { ok: false, ran: 0 };
    })
    .then((result) => {
      process.exit(exitCodeFor(result));
    });
}
