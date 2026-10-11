import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FILE_SECTIONS,
  SECTIONS_HIDDEN_FROM_EMPLOYEES,
  sectionsVisibleToEmployees,
} from '@/lib/platform/fileColors';

/**
 * EXPIRED AND ATTRITION ARE NOT AN EMPLOYEE'S TO SEE — at all.
 *
 * A closed matter and a lost client are the manager's and the admin's. This is
 * stronger than the capability tree's wholesale section visibility, and it
 * overrules it: an employee does not see one of these folders even when they
 * hold an access grant on it, are the assignee of a task on it, or were granted
 * 'files.viewAll.expired'.
 *
 * There are FIVE ways a folder reaches an employee's list — grant, assigned
 * task, general, pinned, wholesale section — so the rule is enforced as an AND
 * over whatever matched rather than inside any one of them. These tests read
 * the source because the alternative is a database: what matters is that the
 * exclusion sits outside the `or`, and that the single-file route agrees with
 * the list route, which is exactly what drifts.
 */

describe('the constant', () => {
  it('names exactly the two terminal sections', () => {
    expect([...SECTIONS_HIDDEN_FROM_EMPLOYEES].sort()).toEqual([
      'attrition',
      'expired',
    ]);
  });

  it('leaves an employee the two live columns', () => {
    expect(sectionsVisibleToEmployees()).toEqual(['potential', 'active']);
  });

  it('hides a strict subset — a manager still has all four', () => {
    expect(FILE_SECTIONS.length).toBe(4);
    for (const s of SECTIONS_HIDDEN_FROM_EMPLOYEES) {
      expect(FILE_SECTIONS).toContain(s);
    }
  });
});

describe('the wholesale grant no longer admits them', () => {
  const src = readFileSync('lib/platform/fileVisibility.ts', 'utf8');

  it('filters the hidden sections out of what a grant returns', () => {
    // Granting 'files.viewAll.expired' must stop admitting anyone. The KEY is
    // deliberately not revoked — keys are permanent, and a folder moved into
    // Expired must not silently destroy the record of who had access.
    expect(src).toContain('SECTIONS_HIDDEN_FROM_EMPLOYEES');
    expect(src).toMatch(/!SECTIONS_HIDDEN_FROM_EMPLOYEES\.includes\(s\)/);
  });
});

describe('the list excludes them however the folder was reached', () => {
  const src = readFileSync('lib/platform/files.ts', 'utf8');

  it('applies the exclusion OUTSIDE the or-group, so it ANDs over every route', () => {
    // Inside the `or` it would be just another way to match. Outside, it
    // subtracts from whatever matched — which is the difference between "one
    // more branch" and "a rule".
    expect(src).toMatch(
      /q = q\.not\('section', 'in', `\(\$\{SECTIONS_HIDDEN_FROM_EMPLOYEES\.join\(','\)\}\)`\)/
    );
  });

  it('applies it to the employee query, not the company-wide one', () => {
    // listFilesForCompany feeds managers and admins, who keep all four.
    const employeeFn = src.slice(src.indexOf('export async function listFilesForEmployee'));
    expect(employeeFn).toContain("q.not('section', 'in'");
  });
});

describe('opening one by URL is refused too', () => {
  const src = readFileSync('app/api/files/[id]/route.ts', 'utf8');

  it('overrules every other reason the folder would be visible', () => {
    // The five reasons are ORed; this must sit in front of them as an AND, or
    // a pinned Expired folder would still open.
    expect(src).toMatch(
      /!SECTIONS_HIDDEN_FROM_EMPLOYEES\.includes\(file\.section\) &&[\s\S]{0,400}?isFileAssignedToUser/
    );
  });
});

describe('the board does not offer the tabs', () => {
  const src = readFileSync('components/FilesView.tsx', 'utf8');

  it('builds its columns from the shared helper, not the raw list', () => {
    expect(src).toContain('sectionsVisibleToEmployees');
    // Both the tab strip and the kanban board read the narrowed list, so an
    // employee is never shown a column that is always empty.
    expect(src).not.toContain('FILE_SECTIONS.map((s) => (');
  });

  it('gives a manager or admin all four', () => {
    expect(src).toMatch(/role === 'admin' \|\| role === 'manager'[\s\S]{0,120}?FILE_SECTIONS/);
  });
});
