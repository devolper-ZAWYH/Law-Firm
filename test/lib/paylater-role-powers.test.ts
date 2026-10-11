import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paylaterAccess } from '@/lib/platform/paylater';
import { makePlatformUser, COMPANY_A, MANAGER_ID } from '../helpers/platformUser';

/**
 * WHAT EACH PAYLATER ROLE MAY DO, checked against the source documents.
 *
 * The journey and the gates spec give the four roles four different jobs:
 *
 *   Team Leader  divides the batches (¶22), assigns the notice date (¶28),
 *                does the final review (¶36), and holds the override.
 *   Employee     prepares the files (¶27), sends the notices (¶56), handles
 *                communication and settlements (¶64–84).
 *   Lawyer       stamps and signs the notice (¶37–38) — gate 2.3.
 *   Auditor      audits and prints the legal memo (¶43–45) — gate 2.5.
 *
 * The lawyer and the auditor close two DIFFERENT steps on the same file, on
 * purpose: each is a check on the other. Letting either one also edit the
 * intake data would let the person who signs a notice change the debt it
 * claims, which removes the check entirely.
 *
 * THESE ARE BEHAVIOURAL NOW. They used to grep the source for the shape of the
 * rule, "because the behaviour itself needs a database". It no longer does:
 * paylaterAccess reads the role off the membership the identity query already
 * loaded, so it is a pure function of (PlatformUser, companyId) and can simply
 * be called.
 *
 * That change matters, because the grep tests could not do the job. The
 * canEditFiles one asserted the rule did not CONTAIN the string 'lawyer' —
 * which was true while a lawyer who also held a manager membership got
 * canEditFiles anyway, through the `byRole ||` disjunction. It passed
 * throughout, and passed for the same reason after the fix. A test that cannot
 * fail on the bug it names is worse than no test, because it is counted as
 * cover. The canLead one, meanwhile, pinned the exact source text and broke on
 * a correct change.
 *
 * The route-gating assertions below stay as source checks on purpose: they
 * verify a guard is REFERENCED in each route, which is a structural property
 * of the file, not a behaviour.
 */
const paylater = readFileSync(join(process.cwd(), 'lib/platform/paylater.ts'), 'utf8');

/** A caller with the given platform role and PayLater role, in COMPANY_A. */
function access(
  platform: 'admin' | 'manager' | 'employee',
  paylaterRole: string | null | undefined
) {
  /*
    The admin case still carries a MEMBERSHIP. The PayLater role lives on
    `memberships.paylater_role`, so a person with no membership in the company
    cannot hold one at all — an admin with `memberships: []` and a lawyer role
    is not a state the database can represent. Modelling it that way made the
    role silently vanish and the assertion pass for the wrong reason.
  */
  const pu = makePlatformUser({
    userId: MANAGER_ID,
    isAdmin: platform === 'admin',
    memberships: [
      { companyId: COMPANY_A, role: platform === 'manager' ? 'manager' : 'employee' },
    ],
  });
  // paylater_role rides on the membership — see membershipRows in auth.ts.
  if (pu.memberships[0]) {
    (pu.memberships[0] as { paylaterRole?: string | null }).paylaterRole =
      paylaterRole;
  }
  return paylaterAccess(pu, COMPANY_A);
}

describe('canLead — the Team Leader’s powers', () => {
  it('is the Team Leader, plus admins and managers by role', async () => {
    expect((await access('employee', 'team_leader')).canLead).toBe(true);
    expect((await access('manager', null)).canLead).toBe(true);
    expect((await access('admin', null)).canLead).toBe(true);
    expect((await access('employee', 'employee')).canLead).toBe(false);
  });

  it('is NOT the lawyer or the auditor, even when they are also a manager', async () => {
    // The regression this file exists for. A firm's lawyer commonly holds a
    // manager membership too; before the fix `byRole` granted both rules to
    // them regardless of the PayLater role that was deliberately assigned.
    for (const checker of ['lawyer', 'auditor'] as const) {
      expect((await access('manager', checker)).canLead, checker).toBe(false);
      expect((await access('admin', checker)).canLead, checker).toBe(false);
    }
  });

  it('gates dividing the batch, the notice dates and the imports', () => {
    for (const route of [
      'app/api/paylater/batches/route.ts',
      'app/api/paylater/import/route.ts',
      'app/api/paylater/bulk-dates/route.ts',
      'app/api/paylater/qid-correction/route.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), route), 'utf8');
      expect(src, route).toContain('ctx.access.canLead');
    }
  });
});

describe('canEditFiles — who prepares a file', () => {
  it('is the Employee and the Team Leader', async () => {
    expect((await access('employee', 'employee')).canEditFiles).toBe(true);
    expect((await access('employee', 'team_leader')).canEditFiles).toBe(true);
    expect((await access('manager', null)).canEditFiles).toBe(true);
  });

  it('is NOT the lawyer or the auditor, even when they are also a manager', async () => {
    // Gate 2.3 and gate 2.5 put these two on the same file as checks on each
    // other. A lawyer who can edit the intake signs a notice for a debt they
    // set themselves, which is the check removed.
    for (const checker of ['lawyer', 'auditor'] as const) {
      expect((await access('manager', checker)).canEditFiles, checker).toBe(false);
      expect((await access('admin', checker)).canEditFiles, checker).toBe(false);
      expect((await access('employee', checker)).canEditFiles, checker).toBe(false);
      // …but they still get in. Reading is the whole point of their job.
      expect((await access('manager', checker)).canOpen, checker).toBe(true);
    }
  });

  it('gates the intake write AND the extraction that fills it', () => {
    // Gating the form but not extraction would leave the back door open.
    for (const route of [
      'app/api/paylater/customers/route.ts',
      'app/api/paylater/extract/route.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), route), 'utf8');
      expect(src, route).toContain('ctx.access.canEditFiles');
    }
  });

  it('makes the form read-only rather than letting it 403 on save', () => {
    const form = readFileSync(
      join(process.cwd(), 'components/collections/CustomerForm.tsx'),
      'utf8'
    );
    expect(form).toContain('disabled={!canEditFiles}');
    // A fieldset defaults to min-inline-size:min-content and blows the layout
    // out to the width of the orders table. This is the fix, and it is not
    // obvious enough to survive without a test.
    expect(form).toMatch(/minInlineSize:\s*0/);
  });
});

describe('file assignment — the Team Leader dividing the batch (¶22)', () => {
  it('assignment is a live link to an account, kept apart from handler_name', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260101000036_paylater_assignment.sql'),
      'utf8'
    );
    expect(sql).toContain('add column if not exists assigned_to uuid references app_users(id)');
    // Removing an employee must not delete client files.
    expect(sql).toContain('on delete set null');
  });

  it('only people who can work a file may be assigned one', () => {
    const rule = paylater.slice(
      paylater.indexOf('listAssignableMembers'),
      paylater.indexOf('listAssignableMembers') + 1400
    );
    expect(rule).toContain("'employee'");
    expect(rule).toContain("'team_leader'");
    expect(rule).not.toMatch(/in\(.*'lawyer'/);
  });

  it('the route verifies the assignee rather than trusting the client', () => {
    const src = readFileSync(
      join(process.cwd(), 'app/api/paylater/bulk-dates/route.ts'),
      'utf8'
    );
    expect(src).toContain('listAssignableMembers');
    expect(src).toContain('cannot be assigned PayLater files');
  });

  it('applying only a date does not silently unassign the files', () => {
    const src = readFileSync(
      join(process.cwd(), 'app/api/paylater/bulk-dates/route.ts'),
      'utf8'
    );
    // `undefined` = not sent = leave ownership alone.
    expect(src).toContain("if (assignedTo !== undefined) patch.assigned_to = assignedTo");
  });
});
