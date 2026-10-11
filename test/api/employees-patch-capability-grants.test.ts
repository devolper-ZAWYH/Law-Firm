import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  MANAGER_ID,
  adminUser,
  jsonRequest,
  managerUser,
} from '../helpers/platformUser';
import { argOf, makeSupabaseStub, used } from '../helpers/supabase';

/**
 * Capability-tree counterpart to employees-patch-permissions.test.ts's P1-1
 * suite — PATCH /api/companies/:id/employees/:userId must refuse a non-admin
 * granting CAPABILITY-TREE keys to THEMSELVES, exactly like the legacy
 * `permissions` flags. setCapabilityGrants() re-syncs those same legacy
 * booleans (see lib/platform/capabilityGrants.ts), so a self-grant of
 * 'files.delete' is the same privilege-escalation risk as canDeleteFile.
 */

// This route now consults the approval gate. Ungated here — these tests are
// about WHO may perform the action, not about holding it for an approver.
vi.mock('@/lib/platform/approvals', () => ({
  gateAction: vi.fn(async () => ({ kind: 'run' })),
}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/permissions')>();
  return {
    ...actual,
    getMembershipPermissions: vi.fn(),
    setMembershipPermissions: vi.fn(),
  };
});
vi.mock('@/lib/platform/capabilityGrants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/capabilityGrants')>();
  return {
    ...actual,
    getCapabilityGrants: vi.fn(),
    setCapabilityGrants: vi.fn(),
  };
});
vi.mock('@/lib/platform/workingHours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/workingHours')>();
  return { ...actual, getWorkingHours: vi.fn(), setWorkingHours: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getMembershipPermissions, setMembershipPermissions } = await import(
  '@/lib/platform/permissions'
);
const { getCapabilityGrants, setCapabilityGrants } = await import(
  '@/lib/platform/capabilityGrants'
);
const { getWorkingHours, setWorkingHours } = await import(
  '@/lib/platform/workingHours'
);
const { PATCH } = await import(
  '@/app/api/companies/[id]/employees/[userId]/route'
);

const NO_PERMS = {
  canCreateFile: false,
  canEditFile: false,
  canDeleteFile: false,
  canMoveFileSection: false,
  canCreateTask: false,
  canManageFileAccess: false,
  canUploadAttendance: false,
};
const NO_HOURS = { workingDays: null, startTime: null, endTime: null };

/** The escalation payload: an admin-baseline folder power via the tree. */
const ESCALATION = { capabilityGrants: ['files.delete', 'files.edit'] };

function stubDb() {
  const stub = makeSupabaseStub((q) => {
    const selected = String(argOf(q, 'select') ?? '');
    if (q.table === 'memberships' && selected.includes('zkteco_employee_id')) {
      return { data: { zkteco_employee_id: null } };
    }
    if (q.table === 'memberships') {
      return { data: { role: 'employee' } };
    }
    if (q.table === 'app_users') {
      return {
        data: {
          id: 'target',
          username: 'target@albaker.io',
          email: 'target@albaker.io',
          is_admin: false,
          full_name_en: 'Target',
          full_name_ar: 'هدف',
        },
      };
    }
    return { data: null };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  return stub;
}

async function callPatch(targetUserId: string, body: unknown) {
  const res = await PATCH(jsonRequest(body), {
    params: { id: COMPANY_A, userId: targetUserId },
  });
  return { res, body: (await res.json()) as { ok: boolean; error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    id: 'session-user',
    username: 'u',
    role: 'user',
  });
  vi.mocked(getMembershipPermissions).mockResolvedValue(NO_PERMS);
  vi.mocked(setMembershipPermissions).mockResolvedValue(NO_PERMS);
  vi.mocked(getCapabilityGrants).mockResolvedValue([]);
  vi.mocked(setCapabilityGrants).mockResolvedValue([]);
  vi.mocked(getWorkingHours).mockResolvedValue(NO_HOURS);
  vi.mocked(setWorkingHours).mockResolvedValue(NO_HOURS);
  stubDb();
});

describe('PATCH employees — self-granted capability escalation', () => {
  it('refuses a manager granting capabilityGrants to THEMSELVES', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callPatch(MANAGER_ID, ESCALATION);

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
  });

  it('never reaches the capability write on a self-grant attempt', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    await callPatch(MANAGER_ID, ESCALATION);

    expect(setCapabilityGrants).not.toHaveBeenCalled();
  });

  it('rejects an unknown/invalid capability key with 400', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res } = await callPatch(EMPLOYEE_ID, {
      capabilityGrants: ['files.delete', 'not.a.real.key'],
    });

    expect(res.status).toBe(400);
    expect(setCapabilityGrants).not.toHaveBeenCalled();
  });
});

describe('PATCH employees — the intended manager workflow still works', () => {
  it('lets a manager grant capabilities to ANOTHER member of their company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callPatch(EMPLOYEE_ID, ESCALATION);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(setCapabilityGrants).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      ['files.delete', 'files.edit'],
      MANAGER_ID,
      // No approvalRequired sent → nothing is gated, which is exactly the
      // behaviour that existed before approvals were added.
      []
    );
  });

  it('lets a global admin set capabilityGrants on their own row (a no-op, not a threat)', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());

    const { res } = await callPatch(adminUser().userId, ESCALATION);

    expect(res.status).toBe(200);
    expect(setCapabilityGrants).toHaveBeenCalled();
  });

  it('still 404s when the target is not a member of this company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const stub = makeSupabaseStub((q) =>
      q.table === 'memberships' ? { data: null } : { data: null }
    );
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    const { res } = await callPatch(EMPLOYEE_ID, ESCALATION);

    expect(res.status).toBe(404);
    expect(setCapabilityGrants).not.toHaveBeenCalled();
  });

  it('rejects when smuggled alongside a legitimate field on a self-target', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res } = await callPatch(MANAGER_ID, {
      workingHours: { workingDays: [0, 1, 2, 3, 4] },
      ...ESCALATION,
    });

    expect(res.status).toBe(403);
    expect(setCapabilityGrants).not.toHaveBeenCalled();
    expect(setWorkingHours).not.toHaveBeenCalled();
  });
});
