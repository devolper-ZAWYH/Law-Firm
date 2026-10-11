import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  adminUser,
  employeeUser,
  jsonRequest,
  managerUser,
} from '../helpers/platformUser';
import type { NextRequest } from 'next/server';

/**
 * The standing rule for a new feature: refused without the grant, allowed with
 * the grant ALONE — 'files.summary' must not drag any other folder power along
 * with it. Reading is deliberately wider than writing: anyone already on the
 * folder can read its summary, because it describes work they are doing.
 */

// The route now consults the approval gate. Ungated here — these tests are
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
vi.mock('@/lib/platform/files', () => ({
  getFileById: vi.fn(),
  isFileAssignedToUser: vi.fn(),
}));
vi.mock('@/lib/platform/fileSummary', () => ({
  getFileSummary: vi.fn(),
  saveFileSummary: vi.fn(),
}));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { getFileById, isFileAssignedToUser } = await import('@/lib/platform/files');
const { getFileSummary, saveFileSummary } = await import(
  '@/lib/platform/fileSummary'
);
const route = await import('@/app/api/files/[id]/summary/route');

const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ctx = { params: { id: FILE_ID } };

function getRequest(): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams({ lang: 'en' }) },
  } as unknown as NextRequest;
}

function grantOnly(...keys: string[]) {
  vi.mocked(hasCapabilityGrant).mockImplementation(async (_u, _c, needed) =>
    keys.includes(needed)
  );
}

describe('files.summary capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(getFileById).mockResolvedValue({
      id: FILE_ID,
      companyId: COMPANY_A,
    } as never);
    vi.mocked(isFileAssignedToUser).mockResolvedValue(true);
    vi.mocked(getFileSummary).mockResolvedValue(null);
    vi.mocked(saveFileSummary).mockResolvedValue({
      ok: true,
      summary: {
        fileId: FILE_ID,
        body: 'A contract dispute.',
        createdByName: 'Test Person',
        createdAt: '2026-08-09T00:00:00Z',
        updatedByName: 'Test Person',
        updatedAt: '2026-08-09T00:00:00Z',
      },
    } as never);
  });

  it('lets an assigned employee READ without any grant', async () => {
    grantOnly();
    const res = await route.GET(getRequest(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).canWrite).toBe(false);
  });

  it('refuses an employee NOT on the folder', async () => {
    grantOnly();
    vi.mocked(isFileAssignedToUser).mockResolvedValue(false);
    expect((await route.GET(getRequest(), ctx)).status).toBe(404);
  });

  it('refuses a WRITE without the grant', async () => {
    grantOnly();
    const res = await route.PUT(jsonRequest({ body: 'Mine now.' }), ctx);
    expect(res.status).toBe(403);
    expect(saveFileSummary).not.toHaveBeenCalled();
  });

  it('allows a WRITE with the grant ALONE', async () => {
    grantOnly('files.summary');
    const res = await route.PUT(jsonRequest({ body: 'A contract dispute.' }), ctx);
    expect(res.status).toBe(200);
    expect(saveFileSummary).toHaveBeenCalled();
    expect((await route.GET(getRequest(), ctx)).status).toBe(200);
  });

  it('rejects an empty summary before touching the service', async () => {
    grantOnly('files.summary');
    const res = await route.PUT(jsonRequest({ body: '   ' }), ctx);
    expect(res.status).toBe(400);
    expect(saveFileSummary).not.toHaveBeenCalled();
  });

  it('lets a manager write without any grant', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    grantOnly();
    expect(
      (await route.PUT(jsonRequest({ body: 'Manager wrote this.' }), ctx)).status
    ).toBe(200);
  });

  it('lets an admin write without any grant', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    grantOnly();
    expect(
      (await route.PUT(jsonRequest({ body: 'Admin wrote this.' }), ctx)).status
    ).toBe(200);
  });
});
