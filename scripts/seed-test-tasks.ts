/**
 * Seed a spread of tasks that exercises every state the workload calendar can
 * draw, so the screen can be judged with realistic data instead of one task.
 *
 * Usage:
 *   npm run seed:test-tasks
 *
 * ⚠️  WRITES REAL TASKS to whatever database your env points at. Everything it
 *     creates is titled with the TASK_PREFIX below, and re-running DELETES the
 *     previous batch (and only that batch) before inserting a fresh one, so the
 *     spread stays the same shape however many times you run it. Nothing else
 *     is ever touched. To remove them for good, see "Cleaning up" at the end.
 *
 * WHAT IT DEMONSTRATES — one day per state the bars distinguish:
 *   • comfortably under capacity        (a short green bar)
 *   • exactly at capacity               (a full green bar)
 *   • OVER capacity                     (the bar turns red and clamps)
 *   • work planned but never estimated  (the amber dot; adds nothing to the bar)
 *   • a task on a NON-working day       (over by definition — no allowance)
 *   • several tasks unscheduled         (the pile beside the month)
 *
 * WHY IT WRITES DIRECTLY RATHER THAN THROUGH THE API
 *   createTask() is server-only and the routes need a signed-in session. A
 *   seeder has neither, so it inserts the same columns createTask would —
 *   including the timer fields (assigned_at / last_resumed_at / accumulated),
 *   which the colour engine reads — plus the 'created' event each task's
 *   history starts with. Skipping those would produce tasks that look right in
 *   a list and behave oddly everywhere else.
 *
 * ASSIGNEES must be a member of the file or a manager of the company, so the
 * employee is granted access to the folder first (the same file_access row the
 * Access panel writes). That grant is left in place — it is what makes the
 * employee's own My Files view show the folder with tasks in it.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.development.local' });
config({ path: '.env.local' });
config();

/** Every task this script creates carries this prefix, and nothing else does. */
const TASK_PREFIX = '[demo]';

/** The folder the demo tasks hang off, matched on its client name. */
const FOLDER_CLIENT = 'TEST';

interface Spec {
  /** Days from today. 0 = today, negative = the past. */
  dayOffset: number | null; // null → unscheduled (the pile)
  hours: number | null; // null → no estimate
  who: 'employee' | 'manager';
  title: string;
}

/**
 * The spread. Deliberately small — the point is one clear example of each
 * state, not volume, and a calendar buried under fifty demo tasks teaches
 * nothing about the real one.
 */
const SPECS: Spec[] = [
  // Under capacity: 2.5 of 4 hours.
  { dayOffset: 0, hours: 1, who: 'employee', title: 'Review the signed engagement letter' },
  { dayOffset: 0, hours: 1.5, who: 'employee', title: 'Call the client about the hearing date' },

  // Exactly at capacity: 4 of 4.
  { dayOffset: 1, hours: 4, who: 'employee', title: 'Draft the statement of claim' },

  // OVER capacity: 6 of 4 — the red bar.
  { dayOffset: 2, hours: 3, who: 'employee', title: 'Prepare the bundle for filing' },
  { dayOffset: 2, hours: 3, who: 'employee', title: 'Second reading of the opponent’s reply' },

  // The manager's own day, comfortably under.
  { dayOffset: 3, hours: 2, who: 'manager', title: 'Approve the draft and send to the client' },

  // Estimated + UNESTIMATED on one day: the bar shows 0.5h and the row carries
  // the amber dot saying there is more here than the bar can account for.
  { dayOffset: 4, hours: 0.5, who: 'employee', title: 'File the power of attorney' },
  { dayOffset: 4, hours: null, who: 'employee', title: 'Chase the court registry (unestimated)' },

  // A NON-working day (the schedule is Sun–Thu, so this lands on a Friday or
  // Saturday depending on when it runs): no allowance at all, so any work on
  // it reads as over.
  { dayOffset: 5, hours: 1, who: 'manager', title: 'Weekend: urgent injunction response' },

  // The unscheduled pile, with and without estimates.
  { dayOffset: null, hours: 2, who: 'employee', title: 'Translate the exhibits' },
  { dayOffset: null, hours: 0.5, who: 'employee', title: 'Book the process server' },
  { dayOffset: null, hours: 3, who: 'manager', title: 'Draft the settlement proposal' },
  { dayOffset: null, hours: null, who: 'employee', title: 'Read the new filing (unestimated)' },
];

/** Local YYYY-MM-DD — the same shape the calendar and the column both use. */
function dayKey(offsetFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetFromToday);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function userIdByUsername(
  supabase: SupabaseClient,
  username: string
): Promise<string> {
  const res = await supabase
    .from('app_users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { id: string } | null;
  if (!row) {
    throw new Error(
      `No user "${username}". Run \`npm run seed:test\` first — it creates the three test accounts these tasks are assigned to.`
    );
  }
  return row.id;
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

  const employeeId = await userIdByUsername(supabase, 'test-employee');
  const managerId = await userIdByUsername(supabase, 'test-manager');

  const fileRes = await supabase
    .from('files')
    .select('id, client, company_id')
    .eq('client', FOLDER_CLIENT)
    .limit(1)
    .maybeSingle();
  if (fileRes.error) throw new Error(fileRes.error.message);
  const file = fileRes.data as
    | { id: string; client: string; company_id: string }
    | null;
  if (!file) {
    throw new Error(
      `No folder with client "${FOLDER_CLIENT}". Create one, or change FOLDER_CLIENT at the top of this script.`
    );
  }

  // The employee must be ON the file to be a valid assignee — the same rule
  // createTask enforces. Left in place afterwards: it is what makes their My
  // Files view show this folder with their tasks in it.
  const grant = await supabase
    .from('file_access')
    .upsert(
      { file_id: file.id, user_id: employeeId },
      { onConflict: 'file_id,user_id' }
    );
  if (grant.error) throw new Error(grant.error.message);

  // Remove the PREVIOUS demo batch so re-running keeps the spread the same
  // shape rather than stacking a second copy on every day. Scoped to this
  // script's own prefix — nothing else is touched. Events cascade with them.
  const wiped = await supabase
    .from('tasks')
    .delete()
    .like('title', `${TASK_PREFIX}%`)
    .select('id');
  if (wiped.error) throw new Error(wiped.error.message);
  const removed = ((wiped.data as { id: string }[] | null) ?? []).length;
  if (removed > 0) console.log(`Cleared ${removed} task(s) from a previous run.`);

  const nowIso = new Date().toISOString();
  const rows = SPECS.map((spec) => ({
    file_id: file.id,
    title: `${TASK_PREFIX} ${spec.title}`,
    description: null,
    assignee_id: spec.who === 'employee' ? employeeId : managerId,
    // The approver must be a MANAGER of the company (spec §6).
    approver_id: managerId,
    created_by: managerId,
    status: 'open',
    assigned_at: nowIso,
    accumulated_working_seconds: 0,
    last_resumed_at: nowIso,
    estimated_hours: spec.hours,
    scheduled_date: spec.dayOffset === null ? null : dayKey(spec.dayOffset),
  }));

  const ins = await supabase.from('tasks').insert(rows).select('id, title');
  if (ins.error) throw new Error(ins.error.message);
  const created = (ins.data as { id: string; title: string }[] | null) ?? [];

  // Each task's history starts with a 'created' event, exactly as createTask
  // writes one. Without it the task's timeline opens blank.
  const events = created.map((t) => ({
    task_id: t.id,
    type: 'created',
    actor_id: managerId,
    note: null,
  }));
  const ev = await supabase.from('task_events').insert(events);
  if (ev.error) throw new Error(ev.error.message);

  const scheduled = SPECS.filter((s) => s.dayOffset !== null).length;
  console.log(`\nSeeded ${created.length} demo tasks on "${file.client}".`);
  console.log(`  ${scheduled} placed on days, ${created.length - scheduled} left unscheduled.\n`);
  console.log('What to look for on Employee Tasks → Calendar:');
  console.log(`  ${dayKey(0)}  2.5/4h   under capacity — a short green bar`);
  console.log(`  ${dayKey(1)}  4/4h     exactly full`);
  console.log(`  ${dayKey(2)}  6/4h     OVER — the bar turns red and clamps`);
  console.log(`  ${dayKey(3)}  2/4h     the manager's own row`);
  console.log(`  ${dayKey(4)}  0.5/4h   plus an unestimated task (the amber dot)`);
  console.log(`  ${dayKey(5)}  1/0h     a non-working day — no allowance, so over`);
  console.log('  and four tasks waiting in the unscheduled pile.\n');
  console.log('CLEANING UP — removes only what this script created:');
  console.log(`  delete from tasks where title like '${TASK_PREFIX}%';`);
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
