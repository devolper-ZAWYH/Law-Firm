import { describe, expect, it, vi } from 'vitest';
import { COMPANY_A, adminUser, employeeUser, managerUser } from '../helpers/platformUser';
import { expandCapabilities, isCapabilityKey } from '@/lib/platform/capabilities';

/**
 * Who may set a folder's case number, court and level.
 *
 * Wider than the rest of the core info on purpose: recording a case number is
 * clerical — it is the first thing anyone needs on a matter — whereas changing
 * the client or opponent rewrites what the matter IS. So a MANAGER gets these
 * three fields without the rest, and an employee can be granted exactly them.
 */

vi.mock('@/lib/supabase', () => ({
  // Only reached on the non-privileged path: an employee with no legacy flags.
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  }),
}));

const { canEditCaseDetails, canEditFileCore } = await import('@/lib/platform/permissions');

describe('files.caseDetails capability', () => {
  it('exists in the tree', () => {
    expect(isCapabilityKey('files.caseDetails')).toBe(true);
  });

  it('is a SIBLING of files.edit, not a child', () => {
    // Children satisfy their parent during expansion. If this were nested under
    // files.edit, granting "may set the case number" would silently also grant
    // "may rewrite the client and opponent".
    const caseOnly = expandCapabilities(['files.caseDetails']);
    expect(caseOnly.has('files.caseDetails')).toBe(true);
    expect(caseOnly.has('files.edit')).toBe(false);
  });

  it('is implied by nothing else, and implies nothing else', () => {
    const editOnly = expandCapabilities(['files.edit']);
    expect(editOnly.has('files.caseDetails')).toBe(false);
  });
});

describe('canEditCaseDetails', () => {
  it('allows an admin', async () => {
    expect(await canEditCaseDetails(adminUser(), COMPANY_A, false, false)).toBe(true);
  });

  it('allows a MANAGER — the change that was asked for', async () => {
    expect(await canEditCaseDetails(managerUser(), COMPANY_A, true, false)).toBe(true);
  });

  it('allows an employee granted files.caseDetails', async () => {
    expect(await canEditCaseDetails(employeeUser(), COMPANY_A, false, true)).toBe(true);
  });

  it('refuses a plain employee with neither', async () => {
    expect(await canEditCaseDetails(employeeUser(), COMPANY_A, false, false)).toBe(false);
  });

  it('does NOT widen the core-info gate for a manager', async () => {
    // The whole point of the split: a manager may record the case number and
    // still may not rewrite who the client is.
    expect(await canEditFileCore(managerUser(), COMPANY_A)).toBe(false);
  });
});
