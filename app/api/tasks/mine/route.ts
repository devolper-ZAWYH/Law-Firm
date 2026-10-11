import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser } from '@/lib/platform/auth';
import { listTasksForAssignee } from '@/lib/platform/tasks';
import { getDailyCapacities } from '@/lib/platform/workload';
import { ONLY_COMPANY_NAME_EN } from '@/lib/platform/singleCompany';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/mine — the caller's OWN tasks (assignee_id === caller), across
 * all files, enriched with file briefs + history (so a send-back note shows).
 *
 * Powers the employee "My Files" view AND a manager's self-task section in "My
 * Tasks". Scoped by assignee identity, so any authenticated user may call it —
 * it only returns THEIR tasks.
 *
 * Also returns `me`: the caller as a single calendar row, carrying the DAILY
 * CAPACITY their load is measured against. My Tasks can be read as a calendar
 * now — the same grid a manager sees on Employee Tasks, with one row — and a
 * load bar without a denominator is just a number. Derived from the caller's
 * own schedule exactly as the manager's view derives everyone's; see
 * lib/platform/workload.ts for why capacity is not a separate setting.
 *
 * Best-effort: a capacity that cannot be read must not cost the caller their
 * task list, so it degrades to an unconfigured row and the calendar falls back
 * to the platform default.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  try {
    const tasks = await listTasksForAssignee(pu.userId);

    // The caller's own row for the calendar. Capacity is per COMPANY (it comes
    // from the membership's schedule), so it is read for the company this
    // portal is pinned to, falling back to the caller's first membership.
    const company =
      pu.companies.find((c) => c.nameEn === ONLY_COMPANY_NAME_EN) ??
      pu.companies[0];
    let me: {
      userId: string;
      username: string;
      fullNameEn: string | null;
      fullNameAr: string | null;
      capacityHours: number | null;
      workingDays: number[] | null;
      capacityConfigured: boolean;
      hoursByWeekday: number[] | null;
    } = {
      userId: pu.userId,
      username: pu.username,
      fullNameEn: pu.fullNameEn,
      fullNameAr: pu.fullNameAr,
      capacityHours: null,
      workingDays: null,
      capacityConfigured: false,
      hoursByWeekday: null,
    };
    if (company) {
      try {
        const caps = await getDailyCapacities(company.id, [pu.userId]);
        const cap = caps.get(pu.userId);
        me = {
          ...me,
          capacityHours: cap?.hours ?? null,
          workingDays: cap?.workingDays ?? null,
          capacityConfigured: cap?.configured === true,
          hoursByWeekday: cap?.hoursByWeekday ?? null,
        };
      } catch (capErr) {
        console.error('My tasks capacity load failed:', capErr);
      }
    }

    return NextResponse.json({ ok: true, tasks, me });
  } catch (err) {
    console.error('My tasks list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
