import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { formatMinutes, minutesToHours } from '@/components/WorkloadCalendar';

const myTasks = readFileSync('components/MyTasksView.tsx', 'utf8');
const empTasks = readFileSync('components/EmployeeTasksView.tsx', 'utf8');

/**
 * MY TASKS SERVES TWO PEOPLE, and used to serve only one.
 *
 * A manager opens it to approve work; an employee opens it to see what has
 * been asked of them. Both approval sections were written for the manager and
 * rendered for everybody, so an ordinary employee — who approves nothing, and
 * in most companies cannot be named an approver at all — was shown two large
 * cards saying nothing is awaiting their approval and nothing ever will be.
 * Two empty answers to a question they never asked, above the one thing they
 * came for.
 */
describe('the approval sections', () => {
  it('are gated, not rendered unconditionally', () => {
    expect(myTasks).toContain('showApprovalSections');
    // BOTH of them — the bug was that each rendered on its own.
    const gates = myTasks.match(/\{showApprovalSections && \(/g) ?? [];
    expect(gates.length).toBe(2);
  });

  it('shows them to a manager or admin even when empty', () => {
    // An empty "nothing awaiting you" IS the answer for someone who approves.
    expect(myTasks).toMatch(/approves\s*=\s*role === 'admin' \|\| role === 'manager'/);
    expect(myTasks).toMatch(/showApprovalSections\s*=\s*[\s\S]{0,120}?approves \|\|/);
  });

  it('still shows them to anyone who actually holds something', () => {
    // An employee who WAS named an approver keeps their items.
    expect(myTasks).toMatch(/awaiting\.length > 0 \|\| pendingApproval\.length > 0/);
  });

  it('judges on the UNFILTERED lists, so searching cannot make them vanish', () => {
    // awaitingShown/pendingShown are the search-filtered ones; typing a query
    // that matches nothing must narrow the section, not delete it.
    expect(myTasks).not.toMatch(/showApprovalSections\s*=[\s\S]{0,140}?awaitingShown/);
  });
});

describe('My Tasks reads as a calendar', () => {
  it('offers the same calendar/list pair the manager has', () => {
    expect(myTasks).toContain('WorkloadCalendar');
    expect(myTasks).toContain("useState<'calendar' | 'list'>('calendar')");
  });

  it('is read-only — planning is the manager act the plan route enforces', () => {
    expect(myTasks).toMatch(/canPlan=\{false\}/);
  });

  it('draws the viewer as the single row, with their capacity', () => {
    expect(myTasks).toContain('people={me ? [me] : []}');
  });

  it('shows UNSCHEDULED tasks too, in their own list', () => {
    // The calendar can only draw a task that sits on a day, so on its own it
    // silently hid everything nobody had scheduled — which, for an employee, is
    // most of what they have been asked to do.
    expect(myTasks).toContain('UnscheduledTasks');
    expect(myTasks).toMatch(
      /unscheduledMine[\s\S]{0,160}?myOpenShown\.filter\(\(tk\) => tk\.scheduledDate === null\)/
    );
    expect(myTasks).toContain('tasks={unscheduledMine}');
  });

  it('stacks the pile above the grid, not beside it', () => {
    // .wl-layout's 320px side column is sized for the full-width Employee Tasks
    // page; /me renders in the shell's ~900px reading column.
    expect(myTasks).toContain('wl-layout is-stacked');
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toContain('.wl-layout.is-stacked');
  });

  it('drops the assignee avatar, which is always the viewer here', () => {
    expect(myTasks).toContain('showAssignee={false}');
  });

  it('survives the capacity read failing', () => {
    // `me` is best-effort in /api/tasks/mine; the grid still draws without it.
    const route = readFileSync('app/api/tasks/mine/route.ts', 'utf8');
    expect(route).toContain('My tasks capacity load failed');
    expect(myTasks).toContain('me?.userId');
  });
});

/**
 * THE BOARD MUST AGREE WITH ITSELF.
 *
 * The roster drops frozen accounts and anyone hidden from the calendar. Their
 * TASKS were still in the unscheduled pile — draggable onto a grid with no row
 * to receive them, so a drop made the task disappear — and their scheduled
 * tasks were silently missing from the days.
 */
describe('Employee Tasks filters tasks to the roster', () => {
  it('drops tasks whose assignee has no row', () => {
    expect(empTasks).toContain('rosterIds');
    expect(empTasks).toMatch(
      /rosterIds && \(!tk\.assignee \|\| !rosterIds\.has\(tk\.assignee\.userId\)\)/
    );
  });

  it('does NOT filter when the roster failed to load', () => {
    // people is best-effort: empty means "could not read it", not "nobody
    // works here". Filtering against an empty roster would blank the board.
    expect(empTasks).toMatch(/people\.length > 0 \? new Set/);
  });

  it('filters once, so the pile and the grid cannot disagree', () => {
    // unscheduled is derived from `filtered`, not from `tasks`.
    expect(empTasks).toMatch(/unscheduled[\s\S]{0,120}?filtered\.filter/);
  });
});

/**
 * ARROWS DO NOT MIRROR THEMSELVES.
 *
 * `‹`, `›` and `←` are literal characters. Under RTL a flex row reverses, so
 * the BACK control moves to the reading-start side while its arrow goes on
 * pointing the other way. Arabic is this portal's default language, so the
 * manager's calendar shipped with backwards navigation.
 */
describe('RTL arrows', () => {
  it('mirrors them in CSS', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toContain('.cal-nav-arrow');
    expect(css).toMatch(/\[dir='rtl'\] \.cal-nav-arrow \{\s*transform: scaleX\(-1\);/);
  });

  it('leaves no bare directional arrow outside a mirroring wrapper', () => {
    // Two wrappers mirror under RTL: .cal-nav-arrow (navigation and back
    // links) and .cap-section-chevron (the permissions sections). A directional
    // glyph rendered outside both is one that will point the wrong way in
    // Arabic — the portal's default language.
    const MIRRORING = ['cal-nav-arrow', 'cap-section-chevron'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.tsx')) {
          const src = readFileSync(full, 'utf8');
          const hasArrowInJsx = src
            .split('\n')
            .some((line) => {
              const text = line.trim();
              if (text.startsWith('*') || text.startsWith('//')) return false;
              return /^[\u2039\u203A\u2190\u2192]\s|^\s*[\u2039\u203A\u2190\u2192]\s*$/.test(text);
            });
          if (hasArrowInJsx && !MIRRORING.some((c) => src.includes(c))) {
            offenders.push(full);
          }
        }
      }
    };
    walk('components');
    expect(offenders).toEqual([]);
  });

  it('labels the calendar arrows by direction, not by "month"', () => {
    // They said "Previous month" on every range, so on Week a screen reader
    // announced a month and the button moved seven days.
    expect(empTasks).not.toContain('aria-label={t.prevMonth}');
    expect(empTasks).not.toContain('aria-label={t.nextMonth}');
  });
});


/**
 * A MODAL OPENED FROM A DRAWER MUST SIT ON TOP OF IT.
 *
 * .dash-modal has no z-index and no position of its own, so it stacks with its
 * parent scrim. At 40 that lost to .folder-drawer's 41, and the Edit-task modal
 * opened from the day drawer rendered BEHIND the drawer — half the form covered
 * and its far side unreachable.
 */
describe('modal layering', () => {
  const css = readFileSync('app/globals.css', 'utf8');

  function zOf(selector: string): number {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    const m = block.match(/z-index:\s*(\d+)/);
    expect(m).not.toBeNull();
    return Number(m![1]);
  }

  it('puts the modal above both drawers', () => {
    const modal = zOf('.dash-modal-scrim');
    expect(modal).toBeGreaterThan(zOf('.folder-drawer'));
    expect(modal).toBeGreaterThan(zOf('.collections-drawer'));
  });

  it('leaves the toast above everything', () => {
    expect(zOf('.dash-modal-scrim')).toBeLessThan(zOf('.pl-toast-wrap'));
  });
});

/**
 * A TASK'S TIME IS GIVEN IN MINUTES.
 *
 * "0.25" is not how anybody says a quarter of an hour. The stored column is
 * still estimated_hours numeric(6,2) — stored names are permanent, and the DAY
 * totals are still hours against a working day — so the conversion happens at
 * the UI boundary and has to survive the round trip.
 */
describe('estimates in minutes', () => {
  it('round-trips through the column precision', () => {
    for (const mins of [1, 5, 7, 10, 15, 25, 30, 45, 50, 90, 240, 480]) {
      const stored = minutesToHours(mins);
      // numeric(6,2): two decimals is what the database keeps.
      expect(Number(stored.toFixed(2))).toBe(stored);
      expect(formatMinutes(stored)).toBe(String(mins));
    }
  });

  it('stays inside the column\'s own check constraint', () => {
    // tasks_estimated_hours_positive: > 0 and <= 999.99
    expect(minutesToHours(1)).toBeGreaterThan(0);
    expect(minutesToHours(59999)).toBeLessThanOrEqual(999.99);
  });

  it('no longer labels a task estimate in hours', () => {
    for (const f of [
      'components/UnscheduledTasks.tsx',
      'components/DayTasksDrawer.tsx',
      'components/EmployeeTasksView.tsx',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\$\{formatHours\(tk\.estimatedHours\)\} h/);
      expect(src).not.toContain("'set hours'");
    }
  });

  it('keeps the DAY totals in hours, measured against a working day', () => {
    const cal = readFileSync('components/WorkloadCalendar.tsx', 'utf8');
    expect(cal).toMatch(/\{formatHours\(planned\)\}\/\{formatHours\(allowance\)\}h/);
  });

  it('steps the input in minutes, not quarter hours', () => {
    for (const f of ['components/UnscheduledTasks.tsx', 'components/DayTasksDrawer.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('step="5"');
      expect(src).not.toContain('step="0.25"');
    }
  });
});
