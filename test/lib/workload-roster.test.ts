import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * WHO THE WORKLOAD CALENDAR DRAWS A ROW FOR.
 *
 * The roster is deliberately the whole company and not "people who have tasks"
 * — an empty load bar is the answer when a manager asks who is free. Two kinds
 * of person are left out even so, for two different reasons:
 *
 *   • FROZEN accounts, which cannot sign in and are treated as absent
 *     everywhere authorization is decided. They leave with the account; nobody
 *     has to remember a second switch.
 *   • HIDDEN memberships (#41), a manager's own choice on the employee card.
 *
 * Neither is a permission, and that distinction is what these tests protect:
 * hiding somebody must not touch what they can do, and must not stop work being
 * assigned to them.
 */

const workload = readFileSync('lib/platform/workload.ts', 'utf8');
const overview = readFileSync('app/api/tasks/employee-overview/route.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260101000041_membership_hidden_from_workload.sql',
  'utf8'
);

describe('the exclusion rule', () => {
  it('drops frozen accounts', () => {
    expect(workload).toContain("eq('is_frozen', true)");
  });

  it('drops memberships hidden from the calendar', () => {
    expect(workload).toContain("eq('hidden_from_workload', true)");
  });

  it('is scoped to the company, so a flag in one does not hide a row in another', () => {
    const fn = workload.slice(workload.indexOf('export async function workloadExcludedUserIds'));
    expect(fn).toContain("eq('company_id', companyId)");
  });

  it('survives the migration not having run', () => {
    // New code reaches production before its migration. A missing column must
    // read as "nobody is hidden" — the behaviour before the flag existed —
    // rather than failing the whole overview.
    const fn = workload.slice(workload.indexOf('export async function workloadExcludedUserIds'));
    expect(fn).toContain("42703");
  });
});

describe('the overview applies it', () => {
  it('removes the excluded people from the roster', () => {
    expect(overview).toContain('workloadExcludedUserIds');
    expect(overview).toContain('roster.delete(id)');
  });

  it('excludes BEFORE reading capacities, so nothing is computed for a hidden row', () => {
    const excludeAt = overview.indexOf('workloadExcludedUserIds(');
    const capacitiesAt = overview.indexOf('getDailyCapacities(');
    expect(excludeAt).toBeGreaterThan(-1);
    expect(capacitiesAt).toBeGreaterThan(excludeAt);
  });

  it('still returns the TASKS of a hidden person', () => {
    // Hiding a row is not unassigning work. The task list is built before the
    // roster and is untouched by the exclusion.
    const tasksAt = overview.indexOf('listOpenTasksForCompany(companyId)');
    expect(tasksAt).toBeGreaterThan(-1);
    expect(tasksAt).toBeLessThan(overview.indexOf('workloadExcludedUserIds('));
  });
});

describe('the migration', () => {
  it('is additive and defaults to visible', () => {
    expect(migration).toContain('add column if not exists');
    expect(migration).toContain('default false');
    // Additive-only policy: never a drop or a destructive alter.
    expect(migration.toLowerCase()).not.toContain('drop column');
    expect(migration.toLowerCase()).not.toContain('drop table');
  });
});

describe('setting a time after a task is on a day', () => {
  const drawer = readFileSync('components/DayTasksDrawer.tsx', 'utf8');
  const view = readFileSync('components/EmployeeTasksView.tsx', 'utf8');

  it('the day drawer can edit the estimate, not just display it', () => {
    // The bug: the hours chip was editable in the unscheduled pile and became
    // read-only the moment a task was dropped onto a day — which is exactly
    // when a manager decides how long it will take.
    expect(drawer).toContain('onSetHours');
    expect(drawer).toContain('wl-hours-input');
    expect(drawer).toContain('wl-chip-hours');
  });

  it('offers the control on a task with NO estimate yet', () => {
    // It used to render only `estimatedHours !== null`, so a freshly planned
    // task showed nothing to click. The label is "set time" now — estimates
    // are given in minutes, not fractions of an hour.
    expect(drawer).toContain("'set time'");
  });

  it('is wired from the view to the drawer', () => {
    expect(view).toMatch(/DayTasksDrawer[\s\S]{0,800}?onSetHours=\{onSetHours\}/);
  });

  it('respects canPlan, so a viewer without planning rights cannot edit', () => {
    expect(drawer).toContain('canPlan && beginEdit(tk)');
    expect(drawer).toContain('disabled={!canPlan}');
  });
});
