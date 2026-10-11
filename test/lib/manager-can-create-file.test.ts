import { describe, expect, it, vi } from 'vitest';
import { COMPANY_A, adminUser, employeeUser, managerUser } from '../helpers/platformUser';

/**
 * A manager may create a folder in their own company.
 *
 * canCreateFile checked only isAdmin plus the legacy can_create_file flag, so a
 * manager could move, edit and delete a folder but not create one — the same
 * omission canCreateTaskOnFile had. Reported from testing.
 */

vi.mock('@/lib/supabase', () => ({
  // Reached only on the non-privileged path: an employee with no legacy flags.
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  }),
}));

const { canCreateFile } = await import('@/lib/platform/permissions');

describe('canCreateFile', () => {
  it('allows a MANAGER of the company', async () => {
    expect(await canCreateFile(managerUser(), COMPANY_A, true)).toBe(true);
  });

  it('allows an admin', async () => {
    expect(await canCreateFile(adminUser(), COMPANY_A, false)).toBe(true);
  });

  it('refuses a plain employee with no grant', async () => {
    expect(await canCreateFile(employeeUser(), COMPANY_A, false)).toBe(false);
  });

  it('defaults the manager flag to false when a caller omits it', async () => {
    // Call sites that never pass it keep exactly their previous behaviour.
    expect(await canCreateFile(employeeUser(), COMPANY_A)).toBe(false);
  });
});
