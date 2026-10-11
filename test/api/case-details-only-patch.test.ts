import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, managerUser, adminUser } from '../helpers/platformUser';

/**
 * A PATCH carrying ONLY the case details must be accepted.
 *
 * REGRESSION. When the case fields were split out of hasCore (so a manager
 * could set a case number without being able to rewrite the client), the
 * "nothing to change" guard kept checking only hasSection || hasCore. A
 * case-details-only save therefore looked like an empty request and answered
 * 400 "Invalid request." — to exactly the people the split existed for: a
 * manager, or an employee granted only files.caseDetails, neither of whom can
 * send anything else.
 *
 * An admin never saw it, because their form also posts the core fields. It
 * took driving the app as a manager to surface it.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/approvals', () => ({
  gateAction: vi.fn(async () => ({ kind: 'run' })),
}));
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/permissions', () => ({
  canEditFileCore: vi.fn(async () => false),
  canEditCaseDetails: vi.fn(async () => true),
  canMoveFileSection: vi.fn(async () => false),
  canDeleteFile: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/folderTypes', () => ({
  getFolderTypeByKey: vi.fn(async () => ({ key: 'case', layout: 'case' })),
}));
vi.mock('@/lib/platform/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/files')>();
  return {
    ...actual,
    getFileById: vi.fn(async () => ({
      id: 'file-1',
      companyId: COMPANY_A,
      clientEn: 'Acme',
      clientAr: 'أكمي',
      caseLevel: '',
      folderTypeLayout: 'case',
    })),
    updateFileFields: vi.fn(async () => ({ id: 'file-1', companyId: COMPANY_A })),
    isFileAssignedToUser: vi.fn(async () => true),
  };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { updateFileFields } = await import('@/lib/platform/files');
const { PATCH } = await import('@/app/api/files/[id]/route');

const ctx = { params: { id: 'file-1' } };
function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ sub: 'mgr' } as never);
  vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
});

describe('PATCH with only case details', () => {
  it('is accepted — not treated as an empty request', async () => {
    const res = await PATCH(
      req({ case_number: '9911/2026', court: 'Court of Cassation', case_level: 'cassation' }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(updateFileFields).toHaveBeenCalled();
  });

  it('writes exactly those three fields and nothing else', async () => {
    await PATCH(req({ case_number: '9911/2026', case_level: 'appeal' }), ctx);
    const patch = vi.mocked(updateFileFields).mock.calls[0][1];
    expect(patch.caseNumber).toBe('9911/2026');
    expect(patch.caseLevel).toBe('appeal');
    // A manager may not touch the client — the patch must not carry it.
    expect(patch).not.toHaveProperty('clientContactId');
    expect(patch).not.toHaveProperty('folderLeaderId');
  });

  it('accepts a single case field on its own', async () => {
    const res = await PATCH(req({ case_number: '1/2027' }), ctx);
    expect(res.status).toBe(200);
  });

  it('still refuses a genuinely empty request', async () => {
    // The guard has to keep doing its actual job.
    const res = await PATCH(req({}), ctx);
    expect(res.status).toBe(400);
    expect(updateFileFields).not.toHaveBeenCalled();
  });

  it('an admin sending core fields is unaffected', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await PATCH(req({ case_number: '5/2027' }), ctx);
    expect(res.status).toBe(200);
  });
});
