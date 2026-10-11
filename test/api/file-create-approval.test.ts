import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_A, EMPLOYEE_ID, employeeUser, managerUser } from '../helpers/platformUser';

/**
 * POST /api/files — creating a folder ("add file").
 *
 * 'files.create' was already a grantable capability; what is new is that it can
 * be granted in "requires approval" form. The property pinned here is the one
 * the whole feature rests on: when held, NO folder is created.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/permissions', () => ({ canCreateFile: vi.fn(async () => true) }));
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => true),
}));
vi.mock('@/lib/platform/approvals', () => ({ gateAction: vi.fn() }));
vi.mock('@/lib/platform/folderTypes', () => ({
  getFolderTypeByKey: vi.fn(async () => ({ key: 'case', layout: 'case' })),
}));
vi.mock('@/lib/platform/alerts', () => ({ evaluateAlerts: vi.fn(async () => undefined) }));
vi.mock('@/lib/platform/comments', () => ({
  createComment: vi.fn(async () => undefined),
  notifyMentionedUsers: vi.fn(async () => undefined),
}));
vi.mock('@/lib/platform/files', () => ({
  isFolderType: (v: unknown) => typeof v === 'string',
  createFile: vi.fn(async () => ({ id: 'file-1', clientEn: 'Acme', clientAr: 'أكمي' })),
  grantFileAccess: vi.fn(async () => undefined),
  listFilesForCompany: vi.fn(),
  listFilesForEmployee: vi.fn(),
  getContactBrief: vi.fn(async () => ({ id: 'contact-1', companyId: COMPANY_A })),
  contactDisplayName: () => 'Acme Trading',
  getCompanyMemberBrief: vi.fn(async () => ({ userId: 'leader-1' })),
  memberDisplayName: () => 'Ali AlBaker',
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { gateAction } = await import('@/lib/platform/approvals');
const { createFile } = await import('@/lib/platform/files');
const { POST } = await import('@/app/api/files/route');

const VALID_BODY = {
  company_id: COMPANY_A,
  folder_type: 'case',
  client_contact_id: 'contact-1',
  opponent_en: 'Beta Holdings',
  folder_leader_id: 'leader-1',
  section: 'active',
};

function req(body: Record<string, unknown> = VALID_BODY) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
  vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
  vi.mocked(gateAction).mockResolvedValue({ kind: 'run' } as never);
});

describe('creating a folder', () => {
  it('creates it outright on an ungated grant', async () => {
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(createFile).toHaveBeenCalled();
  });

  it('treats a manager as privileged, so their grant flag is never consulted', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    await POST(req());
    expect(vi.mocked(gateAction).mock.calls[0][0].isPrivileged).toBe(true);
  });

  it('HOLDS a gated grant at 202 and creates NOTHING', async () => {
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-3' },
    } as never);

    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(createFile).not.toHaveBeenCalled();
    expect((await res.json()).code).toBe('pending_approval');
  });

  it('parks the RESOLVED names, not the raw ids the client sent', async () => {
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-3' },
    } as never);
    await POST(req());

    // The folder's NOT NULL display columns are resolved server-side before
    // parking, so approving replays a folder that is already well-formed
    // rather than re-deriving anything at execution time.
    expect(vi.mocked(gateAction).mock.calls[0][0].payload).toMatchObject({
      client: 'Acme Trading',
      managingLawyer: 'Ali AlBaker',
      clientContactId: 'contact-1',
      folderLeaderId: 'leader-1',
      section: 'active',
    });
  });

  it('carries an initial comment into the parked request', async () => {
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-3' },
    } as never);
    await POST(req({ ...VALID_BODY, comment: 'Opened after the intake call.' }));
    expect(vi.mocked(gateAction).mock.calls[0][0].payload).toMatchObject({
      comment: 'Opened after the intake call.',
    });
  });

  it('refuses (409) when gated with no approving manager assigned', async () => {
    vi.mocked(gateAction).mockResolvedValue({ kind: 'no_approver' } as never);
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(createFile).not.toHaveBeenCalled();
    expect((await res.json()).code).toBe('no_approver');
  });

  it('validates BEFORE gating, so a bad request is never parked', async () => {
    const res = await POST(req({ ...VALID_BODY, folder_leader_id: '' }));
    expect(res.status).toBe(400);
    expect(gateAction).not.toHaveBeenCalled();
  });
});
