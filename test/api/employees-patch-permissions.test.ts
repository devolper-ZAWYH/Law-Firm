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
 * P1-1 regression suite — PATCH /api/companies/:id/employees/:userId must not
 * let a non-admin grant permissions to THEMSELVES.
 *
 * The membership_permissions flags extend a member up to actions whose baseline
 * is admin-only (canCreateFile / canEditFile / canDeleteFile — see the table in
 * lib/platform/permissions.ts). Before the fix a manager could PATCH their own
 * userId, self-grant canDeleteFile, and then permanently delete any folder in
 * the company, cascading to its tasks, history and access grants.
 *
 * The intended workflow — a manager granting responsibilities to OTHER people —
 * must keep working, so that is asserted here too.
 */

// This route now consults the approval gate. Ungated here — these tests are
// about WHO may perform the action, not about holding it for an approver.
vi.mock('@/lib/platform/approvals', () => ({
  gateAction: vi.fn(async () => ({ kind: 'run' })),
}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  // Keep the REAL canAdmin / isManagerOfCompany — the predicates under test.
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

/** The escalation payload: admin-baseline folder powers. */
const ESCALATION = {
  permissions: { canDeleteFile: true, canEditFile: true, canCreateFile: true },
};

function stubDb() {
  const stub = makeSupabaseStub((q) => {
    const selected = String(argOf(q, 'select') ?? '');
    if (q.table === 'memberships' && selected.includes('zkteco_employee_id')) {
      return { data: { zkteco_employee_id: null } };
    }
    if (q.table === 'memberships') {
      return { data: { role: 'employee' } }; // the target IS a member
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
  vi.mocked(getWorkingHours).mockResolvedValue(NO_HOURS);
  vi.mocked(setWorkingHours).mockResolvedValue(NO_HOURS);
  stubDb();
});

describe('PATCH employees — self-granted permission escalation', () => {
  it('refuses a manager granting permissions to THEMSELVES', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callPatch(MANAGER_ID, ESCALATION);

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
  });

  it('never reaches the permission write on a self-grant attempt', async () => {
    // The status code alone is not enough — assert the escalation could not
    // have been persisted before the handler returned.
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    await callPatch(MANAGER_ID, ESCALATION);

    expect(setMembershipPermissions).not.toHaveBeenCalled();
  });

  it('refuses a self-grant even when smuggled alongside a legitimate field', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res } = await callPatch(MANAGER_ID, {
      workingHours: { workingDays: [0, 1, 2, 3, 4] },
      ...ESCALATION,
    });

    expect(res.status).toBe(403);
    expect(setMembershipPermissions).not.toHaveBeenCalled();
    expect(setWorkingHours).not.toHaveBeenCalled();
  });
});

describe('PATCH employees — the intended manager workflow still works', () => {
  it('lets a manager grant permissions to ANOTHER member of their company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callPatch(EMPLOYEE_ID, ESCALATION);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(setMembershipPermissions).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      expect.objectContaining({ canDeleteFile: true })
    );
  });

  it('lets a manager still edit their OWN working hours', async () => {
    // The guard is scoped to `permissions` only — it must not block a manager
    // from touching the rest of their own row.
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callPatch(MANAGER_ID, {
      workingHours: { workingDays: [0, 1, 2], startTime: '08:00', endTime: '16:00' },
    });

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(setWorkingHours).toHaveBeenCalledWith(
      MANAGER_ID,
      COMPANY_A,
      expect.objectContaining({ startTime: '08:00' })
    );
  });

  it('lets a global admin set permissions on their own row (a no-op, not a threat)', async () => {
    // Every capability check short-circuits on pu.isAdmin, so an admin
    // self-grant changes nothing — refusing it would be gratuitous.
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());

    const { res } = await callPatch(adminUser().userId, ESCALATION);

    expect(res.status).toBe(200);
    expect(setMembershipPermissions).toHaveBeenCalled();
  });
});

describe('PATCH employees — pre-existing guards are intact', () => {
  it('still refuses a manager sending identity/role fields', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res } = await callPatch(EMPLOYEE_ID, { role: 'manager' });

    expect(res.status).toBe(403);
  });

  it('still 404s when the target is not a member of this company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const stub = makeSupabaseStub((q) =>
      q.table === 'memberships' ? { data: null } : { data: null }
    );
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    const { res } = await callPatch(EMPLOYEE_ID, ESCALATION);

    expect(res.status).toBe(404);
    expect(setMembershipPermissions).not.toHaveBeenCalled();
  });

  it('writes permissions scoped to the target user and company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const stub = stubDb();

    await callPatch(EMPLOYEE_ID, ESCALATION);

    const membershipLookup = stub.queries.find(
      (q) => q.table === 'memberships' && !used(q, 'update')
    );
    expect(membershipLookup?.calls.some((c) => c.method === 'eq')).toBe(true);
  });
});
