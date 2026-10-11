import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { listOpenTasksForCompany } from '@/lib/platform/tasks';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import {
  listCompanyEmployees,
  listCompanyManagers,
} from '@/lib/platform/access';
import {
  getDailyCapacities,
  workloadExcludedUserIds,
} from '@/lib/platform/workload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/employee-overview?company_id=<uuid> — the manager's overview of
 * ALL open tasks across the company's files (who is working on what).
 * Company-isolated: a global admin, a manager of the company, or an employee
 * explicitly granted 'tasks.overview'; anyone outside that company's
 * boundary → 403.
 *
 * Returns TWO things, because the workload calendar needs both and one of them
 * cannot be derived from the other:
 *
 *   • `tasks`  — every open task, each carrying its planned day and estimate.
 *   • `people` — everyone who can hold work in this company, with the DAILY
 *     CAPACITY their load is measured against (lib/platform/workload.ts).
 *
 * The people list is not the set of people who appear in `tasks`. Someone with
 * an empty week has no tasks at all, and inferring the roster from the tasks
 * would erase exactly the person a manager is looking for when they ask who is
 * free — an empty load bar is the most useful row on the screen.
 *
 * TWO KINDS OF PERSON ARE LEFT OUT even so: a FROZEN account, which cannot sign
 * in and is treated as absent everywhere else, and anyone a manager has hidden
 * from this calendar on their employee card (#41). Neither is a permission —
 * their tasks, if any, are unaffected — it is only which rows get drawn.
 */
export async function GET(req: NextRequest) {
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

  const companyId = req.nextUrl.searchParams.get('company_id') ?? '';
  if (!companyId) {
    return NextResponse.json(
      { ok: false, error: 'company_id is required.' },
      { status: 400 }
    );
  }

  const role = roleInCompany(pu, companyId);
  if (role !== 'admin' && role !== 'manager') {
    const granted =
      role === 'employee' &&
      (await hasCapabilityGrant(pu.userId, companyId, 'tasks.overview'));
    if (!granted) {
      return NextResponse.json(
        { ok: false, error: 'Forbidden.' },
        { status: 403 }
      );
    }
  }

  try {
    const tasks = await listOpenTasksForCompany(companyId);

    // THE ROSTER IS BEST-EFFORT, and deliberately loaded after the tasks rather
    // than beside them.
    //
    // The tasks are what this endpoint is for; the roster only decides which
    // load-bar rows the calendar draws. Letting a failure in the second take
    // down the first would mean a company with a broken membership read shows
    // NO TASKS AT ALL — trading a degraded calendar for an empty screen. The
    // client already treats `people` as optional and renders without it.
    let people: unknown[] = [];
    try {
      const [employees, managers] = await Promise.all([
        listCompanyEmployees(companyId),
        // Managers hold work too — a task may be assigned to one (spec §6 lets
        // an assignee be a file member OR a manager), so leaving them out would
        // draw a calendar with tasks belonging to nobody on it.
        listCompanyManagers(companyId),
      ]);

      // De-duplicated by id: the two membership queries are disjoint by role
      // today, but the calendar must not grow a second row for the same person
      // if that ever stops being true.
      const roster = new Map<string, (typeof employees)[number]>();
      for (const p of [...managers, ...employees]) roster.set(p.userId, p);

      // WHO IS NOT PLANNED FOR. A frozen account cannot sign in and is
      // "no such user" everywhere else, and a membership can be hidden from
      // this calendar deliberately (migration #41) — see
      // workloadExcludedUserIds for why those are two different reasons.
      // Removed before capacities are read, so nothing is computed for a row
      // that will not be drawn.
      const excluded = await workloadExcludedUserIds(
        companyId,
        Array.from(roster.keys())
      );
      for (const id of excluded) roster.delete(id);

      const capacities = await getDailyCapacities(
        companyId,
        Array.from(roster.keys())
      );

      people = Array.from(roster.values()).map((p) => {
        const cap = capacities.get(p.userId);
        return {
          ...p,
          capacityHours: cap?.hours ?? null,
          workingDays: cap?.workingDays ?? null,
          capacityConfigured: cap?.configured === true,
          hoursByWeekday: cap?.hoursByWeekday ?? null,
        };
      });
    } catch (rosterErr) {
      console.error('Employee-overview roster load failed:', rosterErr);
    }

    return NextResponse.json({ ok: true, tasks, people });
  } catch (err) {
    console.error('Employee-overview list error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
