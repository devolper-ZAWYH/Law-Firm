# Folder Drawer, Tabbed Detail, and Employee Leave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a folder as a right-edge overlay drawer with Details/Tasks/Comments tabs, and let managers book employee leave that blocks new task assignment and records those days as vacation.

**Architecture:** Three independent slices. (1) CSS + shell change turns the inline split pane into a fixed drawer over a scrim. (2) The 2117-line `FileDetailModal.tsx` is split into a drawer shell plus three tab components under `components/file-detail/`. (3) A new `leave_periods` table with a `lib/platform/leave.ts` service, three API routes behind a new `attendance.leave` capability, an assignment guard inside `lib/platform/tasks.ts`, and an approver notification.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Supabase (service-role only, no RLS policies), Vitest, plain CSS in `app/globals.css`.

## Global Constraints

- Capability keys are **permanent**. Add `attendance.leave`; never rename or repurpose an existing key.
- The drawer is pinned to the **inline-end edge** — right in English, left in Arabic — use `inset-inline-end: 0`.
- The folder-facts block inside the Details tab mirrors by language: **left in Arabic, right in English**.
- Leave is **whole days only**. No half-days, no partial hours.
- Leave **does not** pause task timers or folder colour.
- There is **no manager override** of the assignment block.
- Every user-facing string is bilingual (`en` / `ar`), matching the existing `lang === 'ar' ? … : …` pattern.
- New tables follow the existing convention: `enable row level security` with **no** anon/authenticated policies (service-role access only).
- Every new DB read degrades to empty and every write to a no-op on Postgres `42P01` (missing relation) / `42703` (missing column), as `lib/platform/notifications.ts` does.
- Test command is `npx vitest run <path>`. Full suite: `npm test`.
- Commit messages: imperative mood, no `feat:`/`fix:` prefixes (match existing history), ending with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.
- Final delivery pushes to the **`testing`** remote only. Never `production`.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260101000027_leave_periods.sql` | `leave_periods` table |
| `supabase/schema_leave_periods.sql` | Same DDL, mirroring the `schema_*.sql` convention |
| `lib/platform/leave.ts` | Leave CRUD, on-leave lookups, vacation-day marking |
| `app/api/companies/[id]/leave/route.ts` | GET list, POST create |
| `app/api/companies/[id]/leave/[leaveId]/route.ts` | DELETE remove |
| `components/file-detail/FileDetailDrawer.tsx` | Drawer shell, header, tab switcher |
| `components/file-detail/DetailsTab.tsx` | Facts, edit form, access, colour, move, delete |
| `components/file-detail/TasksTab.tsx` | Add-task form, Not done / Done lists |
| `components/file-detail/CommentsTab.tsx` | Comment log and composer |
| `components/file-detail/types.ts` | Shared props/DTOs for the above |
| `components/LeaveCard.tsx` | The Attendance tab's leave booking card |
| `test/lib/leave-marks-vacation.test.ts` | Vacation day writing |
| `test/lib/leave-overlap.test.ts` | Overlap rejection |
| `test/lib/leave-blocks-assignment.test.ts` | `createTask`/`editTask`/`reassignTask` guard |
| `test/api/leave-capability.test.ts` | `attendance.leave` alone / absent |
| `test/api/leave-approver-notification.test.ts` | Approver notified on booking |

**Modify:**

| Path | Change |
|---|---|
| `app/globals.css:2170-2222` | Replace split-layout rules with drawer + scrim |
| `components/FilesView.tsx:719-750` | Render content full width; drawer when selected |
| `components/FileDetailModal.tsx` | Deleted at the end of Task 6 |
| `lib/platform/capabilities.ts:167-196` | Add `attendance.leave` to the Attendance group |
| `lib/platform/tasks.ts:719,962,1017` | `assignee_on_leave` guard in create/reassign/edit |
| `lib/platform/notifications.ts:16-23` | Add `assignee_on_leave` to `NotificationType` |
| `lib/platform/alerts.ts` | `notifyAssigneeOnLeave` |
| `app/api/files/[id]/tasks/route.ts:85-101,200-220` | `onLeaveUntil` on assignees; 409 for `assignee_on_leave` |
| `components/AttendanceView.tsx` | Mount `LeaveCard` behind the capability |

---

## Task 1: Leave table and service — create, list, overlap

**Files:**
- Create: `supabase/migrations/20260101000027_leave_periods.sql`
- Create: `supabase/schema_leave_periods.sql`
- Create: `lib/platform/leave.ts`
- Test: `test/lib/leave-overlap.test.ts`

**Interfaces:**
- Consumes: `getSupabaseAdmin` from `@/lib/supabase`.
- Produces:
  ```ts
  export interface LeavePeriod {
    id: string; userId: string; companyId: string;
    startDate: string; endDate: string;   // 'YYYY-MM-DD', end inclusive
    note: string | null; createdBy: string | null; createdAt: string;
  }
  export type CreateLeaveResult =
    | { ok: true; period: LeavePeriod }
    | { ok: false; code: 'bad_input' | 'overlap' };
  export function listLeavePeriods(companyId: string, opts?: { userId?: string; from?: string }): Promise<LeavePeriod[]>
  export function createLeavePeriod(input: { companyId: string; userId: string; startDate: string; endDate: string; note: string | null; createdBy: string }): Promise<CreateLeaveResult>
  export function deleteLeavePeriod(id: string, companyId: string): Promise<boolean>
  export function usersOnLeaveOn(companyId: string, date: string): Promise<Map<string, string>>  // userId → endDate
  export function leaveEndFor(userId: string, companyId: string, date: string): Promise<string | null>
  export function todayIso(): string
  ```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260101000027_leave_periods.sql`:

```sql
-- ---------------------------------------------------------------------------
-- LEAVE PERIODS — forward-looking booked leave for an employee.
--
-- Applied automatically by scripts/migrate.ts on deploy — additive and
-- idempotent. Depends on migration #20 (attendance_records) and #2 (memberships).
--
-- WHY THIS EXISTS ALONGSIDE attendance_records.day_status='vacation'
--   day_status is RETROSPECTIVE: the uploader marks a day on a sheet that has
--   already been produced. It cannot answer "is Ahmed away next Tuesday", which
--   is what task assignment needs. A leave period is the forward-looking record;
--   creating one WRITES DOWN into day_status so the two never disagree.
--
-- WHOLE DAYS ONLY. end_date is INCLUSIVE — a one-day leave has start = end.
-- ---------------------------------------------------------------------------

create table if not exists leave_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  note        text,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now()
);

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'leave_periods_range_chk'
  ) then
    alter table leave_periods
      add constraint leave_periods_range_chk check (end_date >= start_date);
  end if;
end $$;

-- "who is on leave on date D" filters company + straddles the range.
create index if not exists leave_periods_company_range_idx
  on leave_periods (company_id, start_date, end_date);

create index if not exists leave_periods_user_idx
  on leave_periods (user_id, start_date);

alter table leave_periods enable row level security;
-- (No anon/authenticated policies on purpose — access only via service-role key.)
```

Copy the identical content to `supabase/schema_leave_periods.sql`.

- [ ] **Step 2: Write the failing test**

Create `test/lib/leave-overlap.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { createLeavePeriod } = await import('@/lib/platform/leave');

/** Rows the overlap probe finds. */
function stubWith(existing: unknown[]) {
  const stub = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'leave_periods' && q.calls.some((c) => c.method === 'select')) {
      return { data: existing };
    }
    if (q.table === 'leave_periods') {
      return {
        data: {
          id: 'leave-1',
          user_id: EMPLOYEE_ID,
          company_id: COMPANY_A,
          start_date: '2026-08-10',
          end_date: '2026-08-14',
          note: null,
          created_by: MANAGER_ID,
          created_at: '2026-08-08T00:00:00Z',
        },
      };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    stub.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
  return stub;
}

const base = {
  companyId: COMPANY_A,
  userId: EMPLOYEE_ID,
  startDate: '2026-08-10',
  endDate: '2026-08-14',
  note: null,
  createdBy: MANAGER_ID,
};

describe('createLeavePeriod', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a period overlapping an existing one for the same person', async () => {
    stubWith([{ id: 'existing', start_date: '2026-08-12', end_date: '2026-08-20' }]);
    const res = await createLeavePeriod(base);
    expect(res).toEqual({ ok: false, code: 'overlap' });
  });

  it('creates when nothing overlaps', async () => {
    stubWith([]);
    const res = await createLeavePeriod(base);
    expect(res.ok).toBe(true);
  });

  it('rejects an end date before the start date', async () => {
    stubWith([]);
    const res = await createLeavePeriod({ ...base, endDate: '2026-08-09' });
    expect(res).toEqual({ ok: false, code: 'bad_input' });
  });

  it('rejects a malformed date', async () => {
    stubWith([]);
    const res = await createLeavePeriod({ ...base, startDate: '10-08-2026' });
    expect(res).toEqual({ ok: false, code: 'bad_input' });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/lib/leave-overlap.test.ts`
Expected: FAIL — `Cannot find module '@/lib/platform/leave'`.

- [ ] **Step 4: Write `lib/platform/leave.ts`**

```ts
import 'server-only';
import { getSupabaseAdmin } from '../supabase';

/**
 * LEAVE PERIODS — booked, forward-looking employee leave.
 *
 * Two jobs, and only two:
 *   • answer "is this person away on date D" so a task cannot be assigned to
 *     someone who is not there (lib/platform/tasks.ts).
 *   • write those days down as attendance vacation days, so an uploaded sheet
 *     never counts a booked holiday as an absence (480 late minutes a day).
 *
 * Leave deliberately does NOT pause task timers or folder colour. A folder with
 * an away assignee keeps ageing; the approver is notified instead and is
 * expected to reassign.
 *
 * WHOLE DAYS ONLY. end_date is inclusive.
 */

export interface LeavePeriod {
  id: string;
  userId: string;
  companyId: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** 'YYYY-MM-DD', INCLUSIVE. */
  endDate: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface LeaveRow {
  id: string;
  user_id: string;
  company_id: string;
  start_date: string;
  end_date: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Missing table/column — the migration has not run yet on this deploy. */
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === '42703';
}

function toPeriod(r: LeaveRow): LeavePeriod {
  return {
    id: r.id,
    userId: r.user_id,
    companyId: r.company_id,
    startDate: r.start_date,
    endDate: r.end_date,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Today as 'YYYY-MM-DD'. Hoisted so tests can freeze it via vi.setSystemTime. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listLeavePeriods(
  companyId: string,
  opts?: { userId?: string; from?: string }
): Promise<LeavePeriod[]> {
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('leave_periods')
    .select('id, user_id, company_id, start_date, end_date, note, created_by, created_at')
    .eq('company_id', companyId);
  if (opts?.userId) q = q.eq('user_id', opts.userId);
  // Current AND upcoming: anything that has not finished yet.
  if (opts?.from) q = q.gte('end_date', opts.from);
  const res = await q.order('start_date', { ascending: true });
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return [];
    throw new Error(res.error.message);
  }
  return ((res.data as LeaveRow[] | null) ?? []).map(toPeriod);
}

export type CreateLeaveResult =
  | { ok: true; period: LeavePeriod }
  | { ok: false; code: 'bad_input' | 'overlap' };

export async function createLeavePeriod(input: {
  companyId: string;
  userId: string;
  startDate: string;
  endDate: string;
  note: string | null;
  createdBy: string;
}): Promise<CreateLeaveResult> {
  const { companyId, userId, startDate, endDate, note, createdBy } = input;
  if (!companyId || !userId) return { ok: false, code: 'bad_input' };
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return { ok: false, code: 'bad_input' };
  }
  if (endDate < startDate) return { ok: false, code: 'bad_input' };

  const supabase = getSupabaseAdmin();

  // OVERLAP: two ranges overlap iff each starts on or before the other ends.
  const clash = await supabase
    .from('leave_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (clash.error) {
    if (!isMissingRelation(clash.error as { code?: string })) {
      throw new Error(clash.error.message);
    }
  } else if (((clash.data as unknown[] | null) ?? []).length > 0) {
    return { ok: false, code: 'overlap' };
  }

  const ins = await supabase
    .from('leave_periods')
    .insert({
      user_id: userId,
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
      note: note && note.trim().length > 0 ? note.trim() : null,
      created_by: createdBy,
    })
    .select('id, user_id, company_id, start_date, end_date, note, created_by, created_at')
    .single();
  if (ins.error) throw new Error(ins.error.message);
  return { ok: true, period: toPeriod(ins.data as LeaveRow) };
}

/** Removes the period. False when nothing matched (wrong company, or gone). */
export async function deleteLeavePeriod(
  id: string,
  companyId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('leave_periods')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)
    .select('id');
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return false;
    throw new Error(res.error.message);
  }
  return ((res.data as unknown[] | null) ?? []).length > 0;
}

/** userId → the last day of their leave, for everyone away on `date`. */
export async function usersOnLeaveOn(
  companyId: string,
  date: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ISO_DATE.test(date)) return out;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('leave_periods')
    .select('user_id, end_date')
    .eq('company_id', companyId)
    .lte('start_date', date)
    .gte('end_date', date);
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return out;
    throw new Error(res.error.message);
  }
  for (const r of (res.data as { user_id: string; end_date: string }[] | null) ?? []) {
    // Overlaps are rejected at write time, so one row per person is expected;
    // the later end date wins if history ever contains an overlap anyway.
    const prev = out.get(r.user_id);
    if (!prev || r.end_date > prev) out.set(r.user_id, r.end_date);
  }
  return out;
}

/** The last day of this person's leave if they are away on `date`, else null. */
export async function leaveEndFor(
  userId: string,
  companyId: string,
  date: string
): Promise<string | null> {
  const away = await usersOnLeaveOn(companyId, date);
  return away.get(userId) ?? null;
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run test/lib/leave-overlap.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260101000027_leave_periods.sql supabase/schema_leave_periods.sql lib/platform/leave.ts test/lib/leave-overlap.test.ts
git commit -m "Add leave_periods table and the leave service"
```

---

## Task 2: Booking leave marks those days as attendance vacation

**Files:**
- Modify: `lib/platform/leave.ts`
- Test: `test/lib/leave-marks-vacation.test.ts`

**Interfaces:**
- Consumes: `getWorkingSchedulesForUsers` from `@/lib/platform/workingHours` (returns `Map<userId, { workingDays: number[] | null; startTime: string | null }>`).
- Produces: `createLeavePeriod` additionally upserts `attendance_records`; `deleteLeavePeriod` removes only the rows it created.

- [ ] **Step 1: Write the failing test**

Create `test/lib/leave-marks-vacation.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub, argOf, type QueryRecord } from '../helpers/supabase';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/workingHours', () => ({
  getWorkingSchedulesForUsers: vi.fn(),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getWorkingSchedulesForUsers } = await import('@/lib/platform/workingHours');
const { createLeavePeriod } = await import('@/lib/platform/leave');

/** `existingDays` are dates that already carry clock data. */
function stub(existingDays: string[] = []) {
  const s = makeSupabaseStub((q: QueryRecord) => {
    if (q.table === 'leave_periods' && q.calls.some((c) => c.method === 'insert')) {
      return {
        data: {
          id: 'leave-1',
          user_id: EMPLOYEE_ID,
          company_id: COMPANY_A,
          start_date: '2026-08-10',
          end_date: '2026-08-12',
          note: null,
          created_by: MANAGER_ID,
          created_at: '2026-08-08T00:00:00Z',
        },
      };
    }
    if (q.table === 'attendance_records' && q.calls.some((c) => c.method === 'select')) {
      return { data: existingDays.map((d) => ({ date: d })) };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    s.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
  return s;
}

const input = {
  companyId: COMPANY_A,
  userId: EMPLOYEE_ID,
  startDate: '2026-08-10', // Monday
  endDate: '2026-08-12',   // Wednesday
  note: null,
  createdBy: MANAGER_ID,
};

describe('createLeavePeriod → attendance vacation days', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Works every day.
    vi.mocked(getWorkingSchedulesForUsers).mockResolvedValue(
      new Map([[EMPLOYEE_ID, { workingDays: null, startTime: null }]])
    );
  });

  it('writes one vacation row per day of the range', async () => {
    const s = stub();
    await createLeavePeriod(input);
    const upsert = s.queries.find(
      (q) => q.table === 'attendance_records' && q.calls.some((c) => c.method === 'upsert')
    );
    expect(upsert).toBeDefined();
    const rows = argOf(upsert!, 'upsert') as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    for (const r of rows) {
      expect(r.day_status).toBe('vacation');
      expect(r.late_minutes).toBe(0);
      expect(r.user_id).toBe(EMPLOYEE_ID);
    }
  });

  it('skips a day that already has recorded clock data', async () => {
    const s = stub(['2026-08-11']);
    await createLeavePeriod(input);
    const upsert = s.queries.find(
      (q) => q.table === 'attendance_records' && q.calls.some((c) => c.method === 'upsert')
    );
    const rows = argOf(upsert!, 'upsert') as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-12']);
  });

  it('skips days the person does not work', async () => {
    // Works Sunday(0) to Thursday(4) only; 2026-08-12 is a Wednesday, so use a
    // range that includes a Friday(5): 2026-08-13 Thu, 2026-08-14 Fri.
    vi.mocked(getWorkingSchedulesForUsers).mockResolvedValue(
      new Map([[EMPLOYEE_ID, { workingDays: [0, 1, 2, 3, 4], startTime: '09:00' }]])
    );
    const s = stub();
    await createLeavePeriod({ ...input, startDate: '2026-08-13', endDate: '2026-08-15' });
    const upsert = s.queries.find(
      (q) => q.table === 'attendance_records' && q.calls.some((c) => c.method === 'upsert')
    );
    const rows = argOf(upsert!, 'upsert') as Array<Record<string, unknown>>;
    // 13th Thu kept; 14th Fri and 15th Sat dropped.
    expect(rows.map((r) => r.date)).toEqual(['2026-08-13']);
  });

  it('still creates the period when no day needs a vacation row', async () => {
    const s = stub(['2026-08-10', '2026-08-11', '2026-08-12']);
    const res = await createLeavePeriod(input);
    expect(res.ok).toBe(true);
    const upsert = s.queries.find(
      (q) => q.table === 'attendance_records' && q.calls.some((c) => c.method === 'upsert')
    );
    expect(upsert).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/lib/leave-marks-vacation.test.ts`
Expected: FAIL — no `attendance_records` upsert is issued.

- [ ] **Step 3: Add the day-marking to `lib/platform/leave.ts`**

Add the import at the top:

```ts
import { getWorkingSchedulesForUsers } from './workingHours';
```

Add these helpers above `createLeavePeriod`:

```ts
/** Every 'YYYY-MM-DD' from start to end inclusive. */
function datesInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  // A booked range is days, not months — the loop is bounded by the check
  // constraint (end >= start) and by the UI, which cannot submit either open.
  while (cur.getTime() <= last.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Write day_status='vacation' across the range, so a sheet uploaded later never
 * counts a booked holiday as an absence (which would be 480 late minutes a day).
 *
 * TWO THINGS ARE DELIBERATELY LEFT ALONE:
 *   • days the person does not work — there is nothing to excuse.
 *   • days that ALREADY have a record — the sheet is the record of what actually
 *     happened, and leave only fills days that have none.
 *
 * Best-effort: a failure here must not undo an accepted leave booking, so it is
 * logged rather than thrown.
 */
async function markVacationDays(input: {
  companyId: string;
  userId: string;
  startDate: string;
  endDate: string;
  uploadedBy: string;
}): Promise<void> {
  const { companyId, userId, startDate, endDate, uploadedBy } = input;
  const supabase = getSupabaseAdmin();

  const schedules = await getWorkingSchedulesForUsers(companyId, [userId]);
  const workingDays = schedules.get(userId)?.workingDays ?? null;
  const days = datesInRange(startDate, endDate).filter((d) => {
    if (!workingDays) return true; // nothing configured → works every day
    return workingDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  });
  if (days.length === 0) return;

  const existing = await supabase
    .from('attendance_records')
    .select('date')
    .eq('user_id', userId)
    .in('date', days);
  if (existing.error) {
    if (isMissingRelation(existing.error as { code?: string })) return;
    console.error('Leave vacation-day probe failed:', existing.error.message);
    return;
  }
  const taken = new Set(
    ((existing.data as { date: string }[] | null) ?? []).map((r) => r.date)
  );
  const rows = days
    .filter((d) => !taken.has(d))
    .map((date) => ({
      user_id: userId,
      company_id: companyId,
      date,
      clock_in: null,
      clock_out: null,
      late_minutes: 0,
      early_out_minutes: 0,
      day_status: 'vacation',
      uploaded_by: uploadedBy,
    }));
  if (rows.length === 0) return;

  const up = await supabase
    .from('attendance_records')
    .upsert(rows, { onConflict: 'user_id,date' });
  if (up.error && !isMissingRelation(up.error as { code?: string })) {
    console.error('Leave vacation-day write failed:', up.error.message);
  }
}
```

Then, in `createLeavePeriod`, replace the final `return { ok: true, … }` with:

```ts
  const period = toPeriod(ins.data as LeaveRow);
  await markVacationDays({
    companyId,
    userId,
    startDate,
    endDate,
    uploadedBy: createdBy,
  });
  return { ok: true, period };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run test/lib/leave-marks-vacation.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Make deletion remove only the auto-written days**

In `deleteLeavePeriod`, before the delete, read the row so its range is known, and after a successful delete remove the rows this created — a vacation day with no clock data:

```ts
export async function deleteLeavePeriod(
  id: string,
  companyId: string
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const found = await supabase
    .from('leave_periods')
    .select('user_id, start_date, end_date')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  if (found.error && !isMissingRelation(found.error as { code?: string })) {
    throw new Error(found.error.message);
  }
  const row = found.data as
    | { user_id: string; start_date: string; end_date: string }
    | null;

  const res = await supabase
    .from('leave_periods')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)
    .select('id');
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return false;
    throw new Error(res.error.message);
  }
  const removed = ((res.data as unknown[] | null) ?? []).length > 0;
  if (!removed || !row) return removed;

  // Only the placeholder rows this booking wrote: vacation, and no clock data.
  // A day the sheet later filled in keeps whatever the sheet said.
  const cleanup = await supabase
    .from('attendance_records')
    .delete()
    .eq('user_id', row.user_id)
    .eq('company_id', companyId)
    .eq('day_status', 'vacation')
    .is('clock_in', null)
    .is('clock_out', null)
    .gte('date', row.start_date)
    .lte('date', row.end_date);
  if (cleanup.error && !isMissingRelation(cleanup.error as { code?: string })) {
    console.error('Leave vacation-day cleanup failed:', cleanup.error.message);
  }
  return true;
}
```

- [ ] **Step 6: Run both leave tests**

Run: `npx vitest run test/lib/leave-marks-vacation.test.ts test/lib/leave-overlap.test.ts`
Expected: PASS, 8 tests total.

- [ ] **Step 7: Commit**

```bash
git add lib/platform/leave.ts test/lib/leave-marks-vacation.test.ts
git commit -m "Record booked leave as attendance vacation days"
```

---

## Task 3: The `attendance.leave` capability and its API routes

**Files:**
- Modify: `lib/platform/capabilities.ts:167-196`
- Create: `app/api/companies/[id]/leave/route.ts`
- Create: `app/api/companies/[id]/leave/[leaveId]/route.ts`
- Test: `test/api/leave-capability.test.ts`

**Interfaces:**
- Consumes: `listLeavePeriods`, `createLeavePeriod`, `deleteLeavePeriod`, `todayIso` (Task 1); `hasCapabilityGrant` from `@/lib/platform/capabilityGrants`; `canAdmin`, `isManagerOfCompany` from `@/lib/platform/auth`.
- Produces: `GET/POST /api/companies/:id/leave`, `DELETE /api/companies/:id/leave/:leaveId`, and the capability key `'attendance.leave'`.

- [ ] **Step 1: Write the failing test**

Create `test/api/leave-capability.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  employeeUser,
  jsonRequest,
  unusedRequest,
} from '../helpers/platformUser';

/**
 * The standing rule for every new feature: a plain employee must be REFUSED
 * without the grant, and ALLOWED with the grant ALONE — holding
 * 'attendance.leave' and nothing else must not also unlock the attendance sheet
 * or anyone else's attendance.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(),
}));
vi.mock('@/lib/platform/leave', () => ({
  listLeavePeriods: vi.fn(),
  createLeavePeriod: vi.fn(),
  deleteLeavePeriod: vi.fn(),
  todayIso: vi.fn(() => '2026-08-08'),
}));
vi.mock('@/lib/platform/alerts', () => ({ notifyAssigneeOnLeave: vi.fn() }));
vi.mock('@/lib/platform/attendance', () => ({
  attendanceSummaryForCompany: vi.fn(async () => []),
  currentAttendancePeriod: vi.fn(() => ({ start: '2026-07-25', end: '2026-08-24' })),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { listLeavePeriods, createLeavePeriod, deleteLeavePeriod } = await import(
  '@/lib/platform/leave'
);
const leaveRoute = await import('@/app/api/companies/[id]/leave/route');
const leaveItemRoute = await import('@/app/api/companies/[id]/leave/[leaveId]/route');
const summaryRoute = await import('@/app/api/companies/[id]/attendance/summary/route');

const ctx = { params: { id: COMPANY_A } };
const itemCtx = { params: { id: COMPANY_A, leaveId: 'leave-1' } };

const body = {
  user_id: EMPLOYEE_ID,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
};

/** Grant exactly the listed keys and nothing else. */
function grantOnly(...keys: string[]) {
  vi.mocked(hasCapabilityGrant).mockImplementation(async (_u, _c, needed) =>
    keys.includes(needed)
  );
}

describe('attendance.leave capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(listLeavePeriods).mockResolvedValue([]);
    vi.mocked(deleteLeavePeriod).mockResolvedValue(true);
    vi.mocked(createLeavePeriod).mockResolvedValue({
      ok: true,
      period: {
        id: 'leave-1',
        userId: EMPLOYEE_ID,
        companyId: COMPANY_A,
        startDate: '2026-08-10',
        endDate: '2026-08-14',
        note: null,
        createdBy: EMPLOYEE_ID,
        createdAt: '2026-08-08T00:00:00Z',
      },
    });
  });

  it('refuses GET without the grant', async () => {
    grantOnly();
    const res = await leaveRoute.GET(unusedRequest, ctx);
    expect(res.status).toBe(403);
  });

  it('refuses POST without the grant', async () => {
    grantOnly();
    const res = await leaveRoute.POST(jsonRequest(body), ctx);
    expect(res.status).toBe(403);
    expect(createLeavePeriod).not.toHaveBeenCalled();
  });

  it('refuses DELETE without the grant', async () => {
    grantOnly();
    const res = await leaveItemRoute.DELETE(unusedRequest, itemCtx);
    expect(res.status).toBe(403);
    expect(deleteLeavePeriod).not.toHaveBeenCalled();
  });

  it('allows GET, POST and DELETE with the grant alone', async () => {
    grantOnly('attendance.leave');
    expect((await leaveRoute.GET(unusedRequest, ctx)).status).toBe(200);
    expect((await leaveRoute.POST(jsonRequest(body), ctx)).status).toBe(201);
    expect((await leaveItemRoute.DELETE(unusedRequest, itemCtx)).status).toBe(200);
  });

  it('does NOT also unlock everyone else’s attendance', async () => {
    grantOnly('attendance.leave');
    const res = await summaryRoute.GET(unusedRequest, ctx);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed date without touching the service', async () => {
    grantOnly('attendance.leave');
    const res = await leaveRoute.POST(
      jsonRequest({ ...body, start_date: '10-08-2026' }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(createLeavePeriod).not.toHaveBeenCalled();
  });

  it('reports an overlapping booking as 409', async () => {
    grantOnly('attendance.leave');
    vi.mocked(createLeavePeriod).mockResolvedValue({ ok: false, code: 'overlap' });
    const res = await leaveRoute.POST(jsonRequest(body), ctx);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/api/leave-capability.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/companies/[id]/leave/route'`.

- [ ] **Step 3: Add the capability key**

In `lib/platform/capabilities.ts`, inside the `attendance` group's `capabilities` array (after the `attendance.viewAll` entry, before the closing `]`):

```ts
      {
        key: 'attendance.leave',
        en: 'Set leave days for employees',
        ar: 'تحديد أيام إجازة الموظفين',
        hintEn:
          'Booked leave blocks new tasks being assigned to that person, and records those days as vacation.',
        hintAr:
          'الإجازة المسجلة تمنع إسناد مهام جديدة لهذا الشخص، وتسجل تلك الأيام كإجازة.',
      },
```

Do **not** add it to `LEGACY_CAPABILITY_MAP` — it has no legacy boolean and is enforced through `hasCapabilityGrant`.

- [ ] **Step 4: Write the list/create route**

Create `app/api/companies/[id]/leave/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, isManagerOfCompany } from '@/lib/platform/auth';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { listLeavePeriods, createLeavePeriod, todayIso } from '@/lib/platform/leave';
import { notifyAssigneeOnLeave } from '@/lib/platform/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Booked employee leave for one company.
 *
 * Admin, a manager of the company, or an employee granted 'attendance.leave'.
 * That grant does NOT imply any other attendance access — the sheet upload and
 * the company-wide summary stay behind their own keys.
 */
async function authorize(companyId: string) {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }) };
  const pu = await getPlatformUser(session);
  if (!pu) return { error: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }) };
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, companyId) &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'attendance.leave'))
  ) {
    return { error: NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 }) };
  }
  return { pu };
}

/** GET — current and upcoming periods (anything not yet finished). */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  try {
    const periods = await listLeavePeriods(params.id, { from: todayIso() });
    return NextResponse.json({ ok: true, periods });
  } catch (err) {
    console.error('Leave list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** POST — book leave. Body: { user_id, start_date, end_date, note? }. */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  const pu = auth.pu!;

  let body: {
    user_id?: unknown;
    start_date?: unknown;
    end_date?: unknown;
    note?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const startDate = typeof body.start_date === 'string' ? body.start_date.trim() : '';
  const endDate = typeof body.end_date === 'string' ? body.end_date.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!userId || !ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return NextResponse.json(
      { ok: false, error: 'An employee, a start date and an end date are required.' },
      { status: 400 }
    );
  }
  if (endDate < startDate) {
    return NextResponse.json(
      { ok: false, error: 'The end date cannot be before the start date.' },
      { status: 400 }
    );
  }

  try {
    const result = await createLeavePeriod({
      companyId: params.id,
      userId,
      startDate,
      endDate,
      note: note.length > 0 ? note : null,
      createdBy: pu.userId,
    });
    if (!result.ok) {
      if (result.code === 'overlap') {
        return NextResponse.json(
          { ok: false, error: 'This person already has leave booked over those dates.' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'An employee, a start date and an end date are required.' },
        { status: 400 }
      );
    }
    // Tell the approver of every open task this person is holding, so the work
    // can be reassigned. Best-effort — a failed notification must not undo the
    // booking that already succeeded.
    try {
      await notifyAssigneeOnLeave(result.period);
    } catch (notifyErr) {
      console.error('notifyAssigneeOnLeave failed:', notifyErr);
    }
    return NextResponse.json({ ok: true, period: result.period }, { status: 201 });
  } catch (err) {
    console.error('Leave create error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 5: Write the delete route**

Create `app/api/companies/[id]/leave/[leaveId]/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, isManagerOfCompany } from '@/lib/platform/auth';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { deleteLeavePeriod } from '@/lib/platform/leave';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string; leaveId: string } };

/**
 * DELETE /api/companies/:id/leave/:leaveId — cancel booked leave.
 *
 * Same gate as booking it. Company-scoped in the service layer, so a leaveId
 * from another company is simply not found.
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, params.id) &&
    !(await hasCapabilityGrant(pu.userId, params.id, 'attendance.leave'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const removed = await deleteLeavePeriod(params.leaveId, params.id);
    if (!removed) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Leave delete error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 6: Add the notification stub so the route imports resolve**

In `lib/platform/notifications.ts`, extend the union at line 16:

```ts
export type NotificationType =
  | 'overdue_warn'
  | 'overdue_critical'
  | 'task_created'
  | 'task_done'
  | 'task_sent_back'
  | 'mention'
  | 'attendance_objection'
  | 'assignee_on_leave';
```

In `lib/platform/alerts.ts`, append (the real body arrives in Task 5):

```ts
/**
 * Someone was booked on leave while holding open tasks → tell each task's
 * APPROVER, who is the person able to reassign it. Leave does not pause the
 * task clock, so this notice is the whole mechanism by which the work gets
 * picked up. Best-effort.
 */
export async function notifyAssigneeOnLeave(period: {
  userId: string;
  companyId: string;
  endDate: string;
}): Promise<void> {
  void period;
}
```

- [ ] **Step 7: Run the test to confirm it passes**

Run: `npx vitest run test/api/leave-capability.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add lib/platform/capabilities.ts lib/platform/notifications.ts lib/platform/alerts.ts app/api/companies/\[id\]/leave test/api/leave-capability.test.ts
git commit -m "Add the attendance.leave capability and its API routes"
```

---

## Task 4: Leave blocks task assignment

**Files:**
- Modify: `lib/platform/tasks.ts:719` (`createTask`), `:962` (`reassignTask`), `:1017` (`editTask`)
- Modify: `app/api/files/[id]/tasks/route.ts:85-101` (assignee payload), `:200-220` (error mapping)
- Test: `test/lib/leave-blocks-assignment.test.ts`

**Interfaces:**
- Consumes: `leaveEndFor`, `usersOnLeaveOn`, `todayIso` from `@/lib/platform/leave`.
- Produces: the result code `'assignee_on_leave'` on `CreateTaskResult`, `reassignTask`'s and `editTask`'s result types; `onLeaveUntil: string | null` on each entry of the GET response's `assignees`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/leave-blocks-assignment.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/leave', () => ({
  leaveEndFor: vi.fn(),
  todayIso: vi.fn(() => '2026-08-11'),
}));
vi.mock('@/lib/platform/access', () => ({
  isFileMember: vi.fn(async () => true),
  isCompanyManager: vi.fn(async () => true),
  fetchUsersByIds: vi.fn(async () => new Map()),
}));

const { leaveEndFor } = await import('@/lib/platform/leave');
const { createTask } = await import('@/lib/platform/tasks');

const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const input = {
  fileId: FILE_ID,
  companyId: COMPANY_A,
  title: 'Draft the response',
  description: null,
  assigneeId: EMPLOYEE_ID,
  approverId: MANAGER_ID,
  createdBy: MANAGER_ID,
};

describe('createTask — assignee on leave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an assignee who is on leave today', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    const res = await createTask(input);
    expect(res).toEqual({
      ok: false,
      code: 'assignee_on_leave',
      onLeaveUntil: '2026-08-14',
    });
  });

  it('checks leave for the ASSIGNEE, on today’s date, in the file’s company', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue('2026-08-14');
    await createTask(input);
    expect(leaveEndFor).toHaveBeenCalledWith(EMPLOYEE_ID, COMPANY_A, '2026-08-11');
  });

  it('does not refuse when the person is not on leave', async () => {
    vi.mocked(leaveEndFor).mockResolvedValue(null);
    const res = await createTask(input);
    // The DB stub is not wired for the insert path, so this only asserts the
    // guard let it through rather than short-circuiting.
    await expect(Promise.resolve(res)).resolves.not.toEqual(
      expect.objectContaining({ code: 'assignee_on_leave' })
    );
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/lib/leave-blocks-assignment.test.ts`
Expected: FAIL — the first test gets `{ ok: false, code: 'bad_assignee' }` or a thrown insert error, not `assignee_on_leave`.

- [ ] **Step 3: Add the guard to `lib/platform/tasks.ts`**

Add the import near the other `./` imports:

```ts
import { leaveEndFor, todayIso } from './leave';
```

Extend the result type (find `CreateTaskResult`) so the failure carries the return date the UI shows:

```ts
export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; code: 'bad_input' | 'bad_assignee' | 'bad_approver' }
  | { ok: false; code: 'assignee_on_leave'; onLeaveUntil: string };
```

In `createTask`, immediately after the existing assignee check (the block ending `if (!assigneeIsManager) return { ok: false, code: 'bad_assignee' };`) insert:

```ts
  // ON LEAVE — a person who is away cannot be given new work. Enforced here as
  // well as in the picker, so a hand-posted request cannot get round it. There
  // is deliberately no manager override.
  const assigneeLeaveEnd = await leaveEndFor(assigneeId, companyId, todayIso());
  if (assigneeLeaveEnd) {
    return { ok: false, code: 'assignee_on_leave', onLeaveUntil: assigneeLeaveEnd };
  }
```

Apply the same guard, with the same two lines, in `reassignTask` (after its assignee validation) and in `editTask` (only when the edit actually changes the assignee — guard it with `if (nextAssigneeId !== task.assignee_id)` using whatever local name that function already uses for the incoming assignee). Extend both functions' result unions with the same `{ ok: false; code: 'assignee_on_leave'; onLeaveUntil: string }` member.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run test/lib/leave-blocks-assignment.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Surface it on the API**

In `app/api/files/[id]/tasks/route.ts`, add to the imports:

```ts
import { usersOnLeaveOn, todayIso } from '@/lib/platform/leave';
```

In `GET`, replace the assignee-building block (lines 85-101) with:

```ts
    // Assignees = members ∪ managers, deduped, members first. Each carries the
    // last day of any leave they are on right now, so the picker can show them
    // in red and refuse the selection.
    const onLeave = await usersOnLeaveOn(file.companyId, todayIso());
    const seen = new Set<string>();
    const assignees: (AccessPerson & { onLeaveUntil: string | null })[] = [];
    for (const p of [...members, ...managers]) {
      if (seen.has(p.userId)) continue;
      seen.add(p.userId);
      assignees.push({ ...p, onLeaveUntil: onLeave.get(p.userId) ?? null });
    }

    return NextResponse.json({
      ok: true,
      tasks,
      assignees,
      approvers: managers,
      canCreate,
      currentUserId: pu.userId,
    });
```

In `POST`, add a branch before the existing `bad_assignee` branch:

```ts
      if (result.code === 'assignee_on_leave') {
        return NextResponse.json(
          {
            ok: false,
            error: `That person is on leave until ${result.onLeaveUntil} — assign this task to someone else.`,
          },
          { status: 409 }
        );
      }
```

Apply the same 409 mapping in the task PATCH route that handles reassign/edit (`app/api/tasks/[id]/route.ts`) wherever it maps `bad_assignee`.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — every pre-existing test still green.

- [ ] **Step 7: Commit**

```bash
git add lib/platform/tasks.ts app/api/files/\[id\]/tasks/route.ts app/api/tasks/\[id\]/route.ts test/lib/leave-blocks-assignment.test.ts
git commit -m "Refuse to assign a task to someone on leave"
```

---

## Task 5: Notify the approver of open tasks held by someone going on leave

**Files:**
- Modify: `lib/platform/alerts.ts` (replace the Task 3 stub)
- Test: `test/api/leave-approver-notification.test.ts`

**Interfaces:**
- Consumes: `listTasksForAssignee` from `@/lib/platform/tasks`; `insertNotifications` from `@/lib/platform/notifications`.
- Produces: `notifyAssigneeOnLeave(period: { userId: string; companyId: string; endDate: string }): Promise<void>`.

- [ ] **Step 1: Confirm the shape `listTasksForAssignee` returns**

Run: `grep -n "export async function listTasksForAssignee" -A 20 lib/platform/tasks.ts`
Use the actual field names it returns (`id`, `title`, `approverId`/`approver_id`, `status`) in the implementation below — adjust the property names if they differ from the draft.

- [ ] **Step 2: Write the failing test**

Create `test/api/leave-approver-notification.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, MANAGER_ID } from '../helpers/platformUser';

vi.mock('@/lib/platform/tasks', () => ({ listTasksForAssignee: vi.fn() }));
vi.mock('@/lib/platform/notifications', () => ({ insertNotifications: vi.fn() }));

const { listTasksForAssignee } = await import('@/lib/platform/tasks');
const { insertNotifications } = await import('@/lib/platform/notifications');
const { notifyAssigneeOnLeave } = await import('@/lib/platform/alerts');

const period = {
  userId: EMPLOYEE_ID,
  companyId: COMPANY_A,
  endDate: '2026-08-14',
};

describe('notifyAssigneeOnLeave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies the approver of each OPEN task the person holds', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      { id: 't1', title: 'Draft the response', approverId: MANAGER_ID, status: 'open' },
      { id: 't2', title: 'File the appeal', approverId: MANAGER_ID, status: 'open' },
    ] as never);

    await notifyAssigneeOnLeave(period);

    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const items = vi.mocked(insertNotifications).mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      userId: MANAGER_ID,
      companyId: COMPANY_A,
      taskId: 't1',
      type: 'assignee_on_leave',
    });
    expect(items[0].messageEn).toContain('Draft the response');
    expect(items[0].messageEn).toContain('2026-08-14');
    expect(items[0].messageAr).toContain('Draft the response');
  });

  it('ignores tasks that are not open', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([
      { id: 't1', title: 'Done thing', approverId: MANAGER_ID, status: 'approved' },
    ] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it('sends nothing when the person holds no tasks', async () => {
    vi.mocked(listTasksForAssignee).mockResolvedValue([] as never);
    await notifyAssigneeOnLeave(period);
    expect(insertNotifications).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/api/leave-approver-notification.test.ts`
Expected: FAIL — the stub notifies nobody.

- [ ] **Step 4: Replace the stub in `lib/platform/alerts.ts`**

```ts
export async function notifyAssigneeOnLeave(period: {
  userId: string;
  companyId: string;
  endDate: string;
}): Promise<void> {
  const tasks = await listTasksForAssignee(period.userId, period.companyId);
  const open = tasks.filter((t) => t.status === 'open');
  if (open.length === 0) return;
  await insertNotifications(
    open.map((t) => ({
      userId: t.approverId,
      companyId: period.companyId,
      taskId: t.id,
      type: 'assignee_on_leave' as const,
      level: null,
      messageEn: `The assignee of "${t.title}" is on leave until ${period.endDate} — assign it to someone else.`,
      messageAr: `الموظف المسؤول عن "${t.title}" في إجازة حتى ${period.endDate} — أسند المهمة لشخص آخر.`,
    }))
  );
}
```

Add `listTasksForAssignee` to the existing `@/lib/platform/tasks` import at the top of the file if it is not already imported.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run test/api/leave-approver-notification.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/platform/alerts.ts test/api/leave-approver-notification.test.ts
git commit -m "Notify the approver when a task's assignee goes on leave"
```

---

## Task 6: The folder drawer

**Files:**
- Modify: `app/globals.css:2170-2222`
- Modify: `components/FilesView.tsx:719-750`
- Modify: `components/FileDetailModal.tsx:111-142` (the `Shell` component)

**Interfaces:**
- Consumes: `FileDetailModal`'s existing `embedded` prop.
- Produces: CSS classes `.folder-drawer-scrim` and `.folder-drawer`; `FilesView` renders content full width with the drawer above it.

- [ ] **Step 1: Replace the split-layout CSS**

In `app/globals.css`, replace everything from the comment block above `.files-sidebar-layout` through the closing `}` of the `@media (max-width: 900px)` block (roughly lines 2165-2222) with:

```css
/* ---------------------------------------------------------------------------
   FOLDER DRAWER — the selected folder opens over the page, not inside it.

   Pinned to the inline-end edge (`inset-inline-end: 0`) — the right in English,
   the left in Arabic, so it lands on the side the reader's eye ends on. The box
   shadow is the one thing that cannot be logical; it is flipped for RTL.

   The page behind keeps its full width — opening a folder never reflows the
   board — and is dimmed by a scrim that closes the drawer when clicked.
--------------------------------------------------------------------------- */
.folder-drawer-scrim {
  position: fixed;
  inset: 0;
  background: rgba(24, 22, 19, 0.38);
  z-index: 40;
}

.folder-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  inset-inline-end: 0;
  z-index: 41;
  inline-size: min(560px, 100vw);
  /* Its OWN scrollbar: the drawer's content is long (tasks, comments) and must
     not drag the page behind it. */
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--surface, #fffdf9);
  box-shadow: -12px 0 32px rgba(24, 22, 19, 0.18);
  /* Flush to the viewport edge — no page padding, no rounded floating card. */
  border-radius: 0;
  margin: 0;
  max-inline-size: none;
  max-block-size: none;
  padding: 20px;
}

@media (max-width: 700px) {
  .folder-drawer {
    inline-size: 100vw;
    padding: 16px;
  }
}
```

If `--surface` is not a variable this stylesheet defines, use the same literal background the existing `.dash-modal` rule uses — check with `grep -n "^\.dash-modal {" -A 12 app/globals.css`.

- [ ] **Step 2: Render the drawer from `FilesView`**

In `components/FilesView.tsx`, replace lines 710-751 (from the `// Nothing selected:` comment through the closing `})()}`) with:

```tsx
        // The view ALWAYS renders at full width — opening a folder no longer
        // narrows the board. The detail is a drawer over the page instead.
        return (
          <>
            {content}
            {selected && (
              <>
                <div
                  className="folder-drawer-scrim"
                  onClick={() => setSelected(null)}
                  aria-hidden="true"
                />
                <FileDetailModal
                  key={selected.id}
                  embedded
                  file={selected}
                  canMove={canMove}
                  canManageAccess={
                    role === 'admin' ||
                    role === 'manager' ||
                    myPerms.canManageFileAccess
                  }
                  canCreateTask={
                    activeCompany?.isManager === true || myPerms.canCreateTask
                  }
                  canEditTask={isAdmin || role === 'manager' || canEditTaskGrant}
                  canEditCore={isAdmin || myPerms.canEditFile}
                  canDeleteFile={isAdmin || myPerms.canDeleteFile}
                  onClose={() => setSelected(null)}
                  onMoved={onMoved}
                  onTasksChanged={load}
                  onDeleted={onDeleted}
                />
              </>
            )}
          </>
        );
      })()}
```

- [ ] **Step 3: Make the embedded shell a drawer**

In `components/FileDetailModal.tsx`, replace the `Shell` component (lines 116-142) with:

```tsx
function Shell({
  embedded,
  onClose,
  label,
  children,
}: {
  embedded: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  // Esc closes the drawer, as it closes the modal. Registered on the document
  // because focus may be anywhere inside the panel when it is pressed.
  useEffect(() => {
    if (!embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [embedded, onClose]);

  return embedded ? (
    <aside
      className="dash-modal folder-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {children}
    </aside>
  ) : (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
```

`useEffect` is already imported in this file — confirm with `grep -n "^import { " components/FileDetailModal.tsx`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/globals.css components/FilesView.tsx components/FileDetailModal.tsx
git commit -m "Open a folder as a right-edge drawer instead of a split pane"
```

---

## Task 7: Split the folder detail into Details / Tasks / Comments tabs

**Files:**
- Create: `components/file-detail/types.ts`
- Create: `components/file-detail/FileDetailDrawer.tsx`
- Create: `components/file-detail/DetailsTab.tsx`
- Create: `components/file-detail/TasksTab.tsx`
- Create: `components/file-detail/CommentsTab.tsx`
- Modify: `components/FilesView.tsx` (import the drawer)
- Modify: `app/globals.css` (tab strip styles)
- Delete: `components/FileDetailModal.tsx`

**Interfaces:**
- Consumes: everything currently inside `FileDetailModal.tsx` — moved, not rewritten.
- Produces: `export default function FileDetailDrawer(props: FileDetailProps)` where `FileDetailProps` is the existing prop object minus `embedded` (the drawer is always a drawer).

This is a **mechanical extraction**. Behaviour, permission gating, API calls, error messages and comments move across unchanged. The only new code is the tab strip and the language mirroring.

- [ ] **Step 1: Extract the shared prop type**

Create `components/file-detail/types.ts` holding the prop interface currently written inline at `FileDetailModal.tsx:145-188`, named `FileDetailProps`, with the `embedded` field dropped and every existing doc comment carried over verbatim. Re-export `ClientFile` from `../FilesView` for the tab components.

- [ ] **Step 2: Move the comments section**

Create `components/file-detail/CommentsTab.tsx` containing the comments state, effects, handlers and JSX currently in `FileDetailModal.tsx` (the `// ── Comments ──` state block and the `{/* Comments — append-only log… */}` section). Props: `{ file: ClientFile }`.

- [ ] **Step 3: Move the tasks section**

Create `components/file-detail/TasksTab.tsx` containing the tasks state, the add-task form, and the Not done / Done lists. Props: `{ file: ClientFile; canCreateTask: boolean; canEditTask: boolean; onTasksChanged: () => void }`.

- [ ] **Step 4: Move everything else**

Create `components/file-detail/DetailsTab.tsx` containing the facts grid, the core-info edit form, Access, the colour step bar, the Move control and the danger zone. Props: the remaining fields of `FileDetailProps`.

Wrap the facts grid in a container that mirrors by language:

```tsx
{/* The folder's facts sit on the LEFT in Arabic and the RIGHT in English —
    the side the reader's eye lands on first in each script. */}
<div
  className="fd-facts"
  style={{ justifyItems: lang === 'ar' ? 'start' : 'end' }}
>
```

- [ ] **Step 5: Write the drawer shell with the tab strip**

Create `components/file-detail/FileDetailDrawer.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import FolderIcon from '../FolderIcon';
import FolderTitle from '../FolderTitle';
import GoogleDriveIcon from '../GoogleDriveIcon';
import DetailsTab from './DetailsTab';
import TasksTab from './TasksTab';
import CommentsTab from './CommentsTab';
import type { FileDetailProps } from './types';

type Tab = 'details' | 'tasks' | 'comments';

/**
 * The folder detail, as a drawer pinned to the inline-end edge over the Folders
 * page. Three tabs rather than one long scroll: the header carries what
 * identifies the folder, and each tab carries one job.
 */
export default function FileDetailDrawer(props: FileDetailProps) {
  const { file, onClose } = props;
  const { t, lang } = useDash();
  const [tab, setTab] = useState<Tab>('details');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: { key: Tab; en: string; ar: string }[] = [
    { key: 'details', en: 'Details', ar: 'التفاصيل' },
    { key: 'tasks', en: 'Tasks', ar: 'المهام' },
    { key: 'comments', en: 'Comments', ar: 'التعليقات' },
  ];

  return (
    <aside
      className="dash-modal folder-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={t.fileDetailTitle}
    >
      {/* header: folder glyph, title, #id, Drive link, close — unchanged from
          the panel this replaces */}
      {/* … carried over from FileDetailModal.tsx:949-994 … */}

      <div className="fd-tabs" role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={tab === tb.key}
            className={`fd-tab${tab === tb.key ? ' is-active' : ''}`}
            onClick={() => setTab(tb.key)}
          >
            {lang === 'ar' ? tb.ar : tb.en}
          </button>
        ))}
      </div>

      {tab === 'details' && <DetailsTab {...props} />}
      {tab === 'tasks' && (
        <TasksTab
          file={file}
          canCreateTask={props.canCreateTask}
          canEditTask={props.canEditTask}
          onTasksChanged={props.onTasksChanged}
        />
      )}
      {tab === 'comments' && <CommentsTab file={file} />}
    </aside>
  );
}
```

Fill the header placeholder by copying `FileDetailModal.tsx:949-994` verbatim.

- [ ] **Step 6: Add the tab strip styles**

Append to `app/globals.css`:

```css
/* The folder drawer's three tabs. */
.fd-tabs {
  display: flex;
  gap: 4px;
  border-block-end: 1px solid rgba(24, 22, 19, 0.1);
  margin-block: 12px 16px;
}

.fd-tab {
  appearance: none;
  background: none;
  border: 0;
  border-block-end: 2px solid transparent;
  padding: 8px 12px;
  font: inherit;
  color: #6b655c;
  cursor: pointer;
}

.fd-tab.is-active {
  color: #2b2823;
  border-block-end-color: #b99a5b;
  font-weight: 600;
}

.fd-facts {
  display: grid;
  gap: 12px 24px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
```

- [ ] **Step 7: Point `FilesView` at the drawer and delete the old file**

In `components/FilesView.tsx`, change the import to
`import FileDetailDrawer from './file-detail/FileDetailDrawer';`, rename the JSX element, and drop the now-meaningless `embedded` prop. Then:

```bash
git rm components/FileDetailModal.tsx
```

- [ ] **Step 8: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; suite green.

- [ ] **Step 9: Commit**

```bash
git add components/file-detail components/FilesView.tsx app/globals.css
git commit -m "Split the folder detail into Details, Tasks and Comments tabs"
```

---

## Task 8: Leave UI — the Attendance card, the red picker, the folder warning

**Files:**
- Create: `components/LeaveCard.tsx`
- Modify: `components/AttendanceView.tsx`
- Modify: `components/file-detail/TasksTab.tsx`
- Modify: `components/file-detail/DetailsTab.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `GET/POST /api/companies/:id/leave`, `DELETE /api/companies/:id/leave/:leaveId`; `assignees[].onLeaveUntil` from `GET /api/files/:id/tasks`; `capabilities` from `GET /api/companies/:id/permissions/me`.
- Produces: `export default function LeaveCard({ companyId }: { companyId: string })`.

- [ ] **Step 1: Build the leave card**

Create `components/LeaveCard.tsx`: an employee `<select>` (fed from the company employees the Attendance view already loads, or `GET /api/companies/:id/employees`), `start`/`end` `<input type="date">`, an optional note, an Add button, and a list of current/upcoming periods each with a Remove button. Bilingual labels via `useDash()`. On a 409, show the returned message. Follow the fetch/`cache: 'no-store'`/error-state pattern already used in `AttendanceView.tsx:83-105`.

- [ ] **Step 2: Mount it behind the capability**

In `components/AttendanceView.tsx`, extend the existing permissions effect to also record `attendance.leave`:

```ts
setCanSetLeave(
  Array.isArray(data.capabilities) && data.capabilities.includes('attendance.leave')
);
```

and render `{(isAdmin || isManager || canSetLeave) && companyId && <LeaveCard companyId={companyId} />}`.

- [ ] **Step 3: Red, unselectable assignees**

In `components/file-detail/TasksTab.tsx`, where the assignee `<option>` list is built, use `onLeaveUntil`:

```tsx
{assignees.map((a) => (
  <option key={a.userId} value={a.userId} disabled={a.onLeaveUntil !== null}>
    {memberLabel(a)}
    {a.onLeaveUntil
      ? lang === 'ar'
        ? ` — في إجازة حتى ${a.onLeaveUntil}`
        : ` — on leave until ${a.onLeaveUntil}`
      : ''}
  </option>
))}
```

Add `.fd-assignee-on-leave { color: #C24A3C; }` to `app/globals.css` and apply it to the option via `className`. (A `<select>`'s options accept colour in every browser this portal targets; if it does not render, fall back to showing the red note beneath the field instead — do not leave the state invisible.)

- [ ] **Step 4: The red warning on the folder**

In `components/file-detail/DetailsTab.tsx`, for each open task whose assignee is on leave, render above the facts:

```tsx
<div className="dash-alert dash-alert-error" role="status">
  {lang === 'ar'
    ? `${assigneeName} في إجازة حتى ${onLeaveUntil} — أسند المهمة "${taskTitle}" لموظف آخر.`
    : `${assigneeName} is on leave until ${onLeaveUntil} — assign the task "${taskTitle}" to another employee.`}
</div>
```

The data comes from the same `GET /api/files/:id/tasks` response: cross-reference each open task's `assigneeId` against the `assignees` entries carrying a non-null `onLeaveUntil`. Lift that fetch into `FileDetailDrawer` and pass it to both tabs rather than fetching twice.

- [ ] **Step 5: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; suite green.

- [ ] **Step 6: Commit**

```bash
git add components/LeaveCard.tsx components/AttendanceView.tsx components/file-detail app/globals.css
git commit -m "Add the leave card, red on-leave assignees and the folder warning"
```

---

## Task 9: Verify in the running app, then push to testing

**Files:** none changed unless verification finds a defect.

- [ ] **Step 1: Start the dev server**

Create `.claude/launch.json` if absent:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "albaker-portal", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }
  ]
}
```

Start it with the `preview_start` tool (never `Bash`). **If it is not serving within 60 seconds**, stop trying: fall back to `npm test` plus `npx next build` as the evidence, and say plainly in the final report that the browser checks did not run and which claims are therefore unverified.

- [ ] **Step 2: Verify the drawer**

Open the Folders page, click a folder. Confirm: the board does not narrow, the drawer is flush to the **right** edge in both English and Arabic, it has its own scrollbar, the page behind is dimmed, and clicking the dim area, pressing Esc, or clicking × all close it. Capture a screenshot.

- [ ] **Step 3: Verify the tabs**

Switch between Details, Tasks and Comments. Confirm each renders its own content, that opening a different folder resets to Details, and that the facts block sits left in Arabic and right in English.

- [ ] **Step 4: Verify leave end to end**

In Attendance, book leave for an employee covering today. Then open a folder they can be assigned on and confirm they appear red and unselectable in the assignee picker, that the folder shows the red reassign warning if they hold an open task, and that the approver's notification bell carries the new message. Remove the leave and confirm they become selectable again.

- [ ] **Step 5: Verify the permission in isolation**

Grant a plain employee `attendance.leave` and nothing else in the Permissions tab. Confirm they can book and cancel leave, and that the attendance summary and the sheet upload stay hidden from them.

- [ ] **Step 6: Full suite and production build**

Run: `npm test && npx next build`
Expected: all tests pass; the build completes.

- [ ] **Step 7: Push to the testing remote**

```bash
git push testing main
```

Never push to `production`. Report what was verified in the browser and what was not.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Drawer pinned right, flush, own scrollbar, scrim | 6 |
| Click-outside / Esc / × dismissal | 6 |
| Board no longer reflows | 6 |
| `FileDetailModal` split into four components | 7 |
| Details / Tasks / Comments tabs, Details default | 7 |
| Facts block mirrors by language | 7 |
| `leave_periods` table, whole days, overlap rejected | 1 |
| Booking writes `day_status='vacation'`, never over clock data | 2 |
| Cancelling removes only auto-written days | 2 |
| `attendance.leave` capability key, no legacy boolean | 3 |
| Three API routes behind the capability | 3 |
| `assignee_on_leave` guard in create/reassign/edit | 4 |
| Red, unselectable assignee in the picker | 8 |
| Approver notification | 5 |
| Red reassign warning on the folder | 8 |
| Attendance tab leave card | 8 |
| Capability works alone and is refused without | 3 |
| Browser verification, 60s server fallback | 9 |
| Push to `testing` only | 9 |

No gaps.

**Placeholder scan:** Task 7 steps 2-4 describe moves rather than quoting ~1500 lines of existing code; that is deliberate — the code already exists in `FileDetailModal.tsx` and quoting it would invite a rewrite. Every genuinely new line in that task is given in full. Task 5 step 1 asks the implementer to confirm real field names before using them, because `listTasksForAssignee`'s return shape was not read while planning.

**Type consistency:** `LeavePeriod` (camelCase) is used across service, routes and UI; DB rows stay snake_case behind `toPeriod`. `leaveEndFor(userId, companyId, date) → string | null` is used identically in Tasks 4 and 8. `usersOnLeaveOn → Map<userId, endDate>` matches its two call sites. `assignee_on_leave` carries `onLeaveUntil` in the service result, the 409 body and the picker.
