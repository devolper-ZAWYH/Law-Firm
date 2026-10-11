import { describe, expect, it, vi } from 'vitest';
import { COMPANY_A, adminUser, employeeUser, managerUser } from '../helpers/platformUser';

/**
 * A global admin may create a task.
 *
 * canCreateTaskOnFile was the ONLY permission check in permissions.ts that did
 * not consider pu.isAdmin. The effect was oddly specific: an admin without a
 * manager membership could edit, reassign, push back and delete a task, but
 * could not create one — in the UI or through the API. Found by trying it as
 * an admin against a real folder.
 */

vi.mock('@/lib/platform/permissions', async (importOriginal) => {
  return await importOriginal<typeof import('@/lib/platform/permissions')>();
});
vi.mock('@/lib/supabase', () => ({
  // Reached only on the non-privileged path; an employee with no grants.
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  }),
}));

const { canCreateTaskOnFile } = await import('@/lib/platform/permissions');

describe('canCreateTaskOnFile', () => {
  it('allows a global admin who is NOT a manager of the company', async () => {
    // The regression: this returned false.
    expect(await canCreateTaskOnFile(adminUser(), COMPANY_A, false)).toBe(true);
  });

  it('allows a manager of the company', async () => {
    expect(await canCreateTaskOnFile(managerUser(), COMPANY_A, true)).toBe(true);
  });

  it('refuses a plain employee with no grant', async () => {
    expect(await canCreateTaskOnFile(employeeUser(), COMPANY_A, false)).toBe(false);
  });
});
