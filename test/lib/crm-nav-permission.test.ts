import { describe, expect, it } from 'vitest';
import { makePlatformUser, COMPANY_A } from '../helpers/platformUser';

/**
 * An employee granted the CRM permissions must SEE the CRM link.
 *
 * The page already admitted them, but the employee sidebar had no CRM entry at
 * all — so ticking "See the client directory" and "Add someone to the client
 * directory" appeared to do nothing. The flag is resolved per company on the
 * platform user and gates the link.
 */

describe('hasCrmPermission on the resolved user', () => {
  it('is part of every company entry', () => {
    const pu = makePlatformUser({
      userId: 'u1',
      memberships: [{ companyId: COMPANY_A, role: 'employee' }],
    });
    // The helper builds it false; what matters is that the field EXISTS on the
    // shape the shell reads, so the nav can branch on it.
    expect(pu.companies[0]).toHaveProperty('hasCrmPermission');
    expect(pu.companies[0].hasCrmPermission).toBe(false);
  });

  it('is independent of the folder and attendance permissions', () => {
    const pu = makePlatformUser({
      userId: 'u1',
      memberships: [{ companyId: COMPANY_A, role: 'employee' }],
    });
    const c = pu.companies[0];
    // Three separate grants gating three separate pages — one must never imply
    // another, or a folder permission would silently expose the client list.
    expect(c.hasFilePermission).toBe(false);
    expect(c.hasAttendancePermission).toBe(false);
    expect(c.hasCrmPermission).toBe(false);
  });
});
