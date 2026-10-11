import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  employeeUser,
  jsonRequest,
  unusedRequest,
} from '../helpers/platformUser';

/**
 * The standing rule for every new feature: a plain employee must be REFUSED
 * without the grant, and ALLOWED with the grant ALONE — holding
 * 'attendance.leave' and nothing else must not also unlock the attendance sheet
 * or anyone else's attendance.
 */

// This route now consults the approval gate. Ungated here — these tests are
// about WHO may perform the action, not about holding it for an approver.
vi.mock('@/lib/platform/approvals', () => ({
  gateAction: vi.fn(async () => ({ kind: 'run' })),
}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(),
}));
vi.mock('@/lib/platform/leave', () => ({
  listLeavePeriods: vi.fn(),
  createLeavePeriod: vi.fn(),
  deleteLeavePeriod: vi.fn(),
  todayIso: vi.fn(() => '2026-08-08'),
}));
vi.mock('@/lib/platform/alerts', () => ({ notifyAssigneeOnLeave: vi.fn() }));
vi.mock('@/lib/platform/attendance', () => ({
  attendanceSummaryForCompany: vi.fn(async () => []),
  currentAttendancePeriod: vi.fn(() => ({ start: '2026-07-25', end: '2026-08-24' })),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { listLeavePeriods, createLeavePeriod, deleteLeavePeriod } = await import(
  '@/lib/platform/leave'
);
const leaveRoute = await import('@/app/api/companies/[id]/leave/route');
const leaveItemRoute = await import('@/app/api/companies/[id]/leave/[leaveId]/route');
const summaryRoute = await import('@/app/api/companies/[id]/attendance/summary/route');

const ctx = { params: { id: COMPANY_A } };
const itemCtx = { params: { id: COMPANY_A, leaveId: 'leave-1' } };

const body = {
  user_id: EMPLOYEE_ID,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
};

/** Grant exactly the listed keys and nothing else. */
function grantOnly(...keys: string[]) {
  vi.mocked(hasCapabilityGrant).mockImplementation(async (_u, _c, needed) =>
    keys.includes(needed)
  );
}

describe('attendance.leave capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(listLeavePeriods).mockResolvedValue([]);
    vi.mocked(deleteLeavePeriod).mockResolvedValue(true);
    vi.mocked(createLeavePeriod).mockResolvedValue({
      ok: true,
      period: {
        id: 'leave-1',
        userId: EMPLOYEE_ID,
        companyId: COMPANY_A,
        startDate: '2026-08-10',
        endDate: '2026-08-14',
        note: null,
        createdBy: EMPLOYEE_ID,
        createdAt: '2026-08-08T00:00:00Z',
      },
    });
  });

  it('refuses GET without the grant', async () => {
    grantOnly();
    const res = await leaveRoute.GET(unusedRequest, ctx);
    expect(res.status).toBe(403);
  });

  it('refuses POST without the grant', async () => {
    grantOnly();
    const res = await leaveRoute.POST(jsonRequest(body), ctx);
    expect(res.status).toBe(403);
    expect(createLeavePeriod).not.toHaveBeenCalled();
  });

  it('refuses DELETE without the grant', async () => {
    grantOnly();
    const res = await leaveItemRoute.DELETE(unusedRequest, itemCtx);
    expect(res.status).toBe(403);
    expect(deleteLeavePeriod).not.toHaveBeenCalled();
  });

  it('allows GET, POST and DELETE with the grant alone', async () => {
    grantOnly('attendance.leave');
    expect((await leaveRoute.GET(unusedRequest, ctx)).status).toBe(200);
    expect((await leaveRoute.POST(jsonRequest(body), ctx)).status).toBe(201);
    expect((await leaveItemRoute.DELETE(unusedRequest, itemCtx)).status).toBe(200);
  });

  it('does NOT also unlock everyone else’s attendance', async () => {
    grantOnly('attendance.leave');
    const res = await summaryRoute.GET(unusedRequest, ctx);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed date without touching the service', async () => {
    grantOnly('attendance.leave');
    const res = await leaveRoute.POST(
      jsonRequest({ ...body, start_date: '10-08-2026' }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(createLeavePeriod).not.toHaveBeenCalled();
  });

  it('reports an overlapping booking as 409', async () => {
    grantOnly('attendance.leave');
    vi.mocked(createLeavePeriod).mockResolvedValue({ ok: false, code: 'overlap' });
    const res = await leaveRoute.POST(jsonRequest(body), ctx);
    expect(res.status).toBe(409);
  });
});
