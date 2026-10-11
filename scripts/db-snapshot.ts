/**
 * Print a row count for every platform table. READ-ONLY — it issues nothing but
 * counts and never writes, so it is safe to run against production.
 *
 * Usage:
 *   npm run db:snapshot > before.txt
 *   npm run migrate
 *   npm run db:snapshot > after.txt
 *   diff before.txt after.txt
 *
 * WHY THIS EXISTS
 *   Migrations here are additive-only by policy (see scripts/migrate.ts), and
 *   migration #33 adds nullable columns and indexes and nothing else. But
 *   "additive by policy" is a claim about intent, and the way to know a
 *   migration removed nothing is to count the rows on both sides rather than to
 *   re-read the SQL and be reassured.
 *
 *   An empty diff is the evidence. A changed count is not automatically wrong —
 *   a live portal is being used while you work — but it is something to explain
 *   rather than discover later.
 *
 * A table that does not exist yet reports `absent` instead of failing: the
 * schema legitimately differs across environments and deploy windows, and this
 * script's job is to describe what is there, not to insist on a shape.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

/**
 * Every table the platform owns, in dependency order so the output reads like
 * the schema rather than like an alphabet.
 */
const TABLES = [
  'companies',
  'app_users',
  'memberships',
  'membership_capability_grants',
  'files',
  'file_access',
  'file_access_requests',
  'file_comments',
  'file_summaries',
  'folder_types',
  'tasks',
  'task_events',
  'contacts',
  'alerts',
  'notifications',
  'approval_requests',
  'leave_periods',
  'attendance_uploads',
  'attendance_days',
  'attendance_objections',
  '_migrations',
];

/**
 * A count without any rows: `head: true` asks PostgREST for the count in the
 * Content-Range header and no body, so this stays cheap on a large table.
 */
async function countOf(
  supabase: SupabaseClient,
  table: string
): Promise<number | 'absent' | string> {
  const res = await supabase.from(table).select('*', {
    count: 'exact',
    head: true,
  });
  if (res.error) {
    const code = (res.error as { code?: string }).code;
    // 42P01 undefined_table, PGRST205 unknown table in the schema cache.
    if (code === '42P01' || code === 'PGRST205') return 'absent';
    return `error: ${res.error.message}`;
  }
  return res.count ?? 0;
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

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Sequential rather than Promise.all: this runs against a live database and
  // there is no reason to open twenty concurrent connections to print a table.
  for (const table of TABLES) {
    const count = await countOf(supabase, table);
    console.log(`${table.padEnd(32)} ${count}`);
  }

  // Which migrations the database believes it has applied. This is the line
  // that answers "did #33 land?" — and it is recorded only on a COMMITTED
  // migration, so its presence means the file ran to completion.
  const applied = await supabase
    .from('_migrations')
    .select('filename')
    .order('filename', { ascending: true });
  if (!applied.error) {
    const rows = (applied.data as { filename: string }[] | null) ?? [];
    console.log('\napplied migrations:');
    for (const r of rows) console.log(`  ${r.filename}`);
  }
}

main().catch((err: unknown) => {
  console.error('Snapshot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
