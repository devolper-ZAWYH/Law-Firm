import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYLATER_ROLES,
  toPaylaterRole,
  paylaterRoleLabel,
} from '@/lib/platform/paylaterRoles';
import { CAPABILITY_TREE, expandCapabilities } from '@/lib/platform/capabilities';

/**
 * A PayLater role is ONE JOB, and the system must not be able to express two.
 *
 * This shipped once as four capability checkboxes, which let one person be both
 * Lawyer and Auditor — two roles that exist to check each other's work, so
 * holding both collapses a review into a self-review. The fix was structural:
 * the role became a single column, not a set of grants.
 *
 * These tests guard the structure, not the styling. If someone puts the roles
 * back into the capability tree, the second test fails.
 */
describe('the PayLater role is exclusive by construction', () => {
  it('is a closed list of exactly the four roles from the journey', () => {
    expect(PAYLATER_ROLES.map((r) => r.value)).toEqual([
      'team_leader',
      'employee',
      'lawyer',
      'auditor',
    ]);
  });

  it('is NOT in the capability tree — the tree cannot express "exactly one"', () => {
    const keys: string[] = [];
    const walk = (nodes: { key: string; children?: { key: string }[] }[]) => {
      for (const n of nodes) {
        keys.push(n.key);
        if (n.children) walk(n.children as { key: string; children?: { key: string }[] }[]);
      }
    };
    for (const g of CAPABILITY_TREE) {
      keys.push(g.key);
      walk(g.capabilities);
    }
    expect(keys.filter((k) => k.startsWith('paylater'))).toEqual([]);
  });

  it('no stale paylater key survives capability expansion', () => {
    // Even if an old grant row lingered, it must expand to nothing.
    const expanded = expandCapabilities(['paylater.lawyer', 'paylater.auditor']);
    expect([...expanded].filter((k) => k.startsWith('paylater'))).toEqual([]);
  });

  it('migration #35 constrains the column to those four values', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260101000035_paylater_role.sql'),
      'utf8'
    );
    // The database is the last line of defence: a role the dropdown never
    // offers must still be refused if it arrives some other way.
    expect(sql).toMatch(/check\s*\(/i);
    for (const r of PAYLATER_ROLES) expect(sql).toContain(`'${r.value}'`);
    // And the retired capability keys are cleaned up.
    expect(sql).toMatch(/delete from membership_capability_grants/i);
  });

  it('the column is single-valued — it is a text column, not an array', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260101000035_paylater_role.sql'),
      'utf8'
    );
    expect(sql).toContain('add column if not exists paylater_role text');
    expect(sql).not.toContain('paylater_role text[]');
  });
});

/**
 * REGRESSION. The PATCH route refuses a request that changes nothing, by
 * checking a list of "was this field sent?" booleans. A new field added to the
 * route but missed from that list is accepted everywhere EXCEPT when it is the
 * only thing being changed — which is exactly how the Employees card sends it
 * when nothing else on the person was touched.
 *
 * That shipped for a few minutes: setting only the PayLater role answered
 * "No changes provided."
 */
describe('the employee PATCH route recognises paylaterRole as a change', () => {
  const route = readFileSync(
    join(process.cwd(), 'app/api/companies/[id]/employees/[userId]/route.ts'),
    'utf8'
  );

  it('includes hasPaylaterRole in the "no changes provided" guard', () => {
    const guard = route.slice(
      route.indexOf('const hasPaylaterRole'),
      route.indexOf("'No changes provided.'")
    );
    expect(guard).toContain('!hasPaylaterRole');
  });

  it('gates it on people.permissions, not on admin-only identity fields', () => {
    // A manager staffing their own PayLater team must not need an admin.
    const gate = route.slice(
      route.indexOf('hasPaylaterRole &&'),
      route.indexOf('hasPaylaterRole &&') + 400
    );
    expect(gate).toContain("'people.permissions'");
  });

  it('refuses a non-admin setting their OWN role (privilege escalation)', () => {
    const guard = route.slice(
      route.indexOf('!isAdmin &&'),
      route.indexOf('userId === pu.userId') + 40
    );
    expect(guard).toContain('hasPaylaterRole');
  });
});

describe('toPaylaterRole', () => {
  it('accepts each real role', () => {
    for (const r of PAYLATER_ROLES) expect(toPaylaterRole(r.value)).toBe(r.value);
  });

  it('rejects anything else, so a bad value clears rather than corrupts', () => {
    for (const bad of ['', 'admin', 'paylater.lawyer', 'TEAM_LEADER', null, 7, {}]) {
      expect(toPaylaterRole(bad)).toBeNull();
    }
  });
});

describe('paylaterRoleLabel', () => {
  it('labels in both languages', () => {
    expect(paylaterRoleLabel('lawyer', 'en')).toBe('Lawyer');
    expect(paylaterRoleLabel('lawyer', 'ar')).toBe('محامٍ');
  });

  it('renders no role as an empty string, not "null"', () => {
    expect(paylaterRoleLabel(null, 'en')).toBe('');
    expect(paylaterRoleLabel(null, 'ar')).toBe('');
  });
});
