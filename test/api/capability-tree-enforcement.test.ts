import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  employeeUser,
  unusedRequest,
} from '../helpers/platformUser';
import { makeSupabaseStub } from '../helpers/supabase';
import type { NextRequest } from 'next/server';

/**
 * End-to-end coverage for the capability-tree gap fixed across
 * lib/platform/capabilities.ts, lib/platform/capabilityGrants.ts, and the
 * routes below: previously only 7 legacy-mapped capabilities (plus
 * tasks.edit/tasks.delete) were enforced anywhere — every other checkbox in
 * the Permissions tab was decorative. For each capability fixed here, a plain
 * employee (no admin, no manager membership) must be REFUSED without the
 * grant and ALLOWED once granted, exercising the actual route handler.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/platform/capabilityGrants')
  >();
  return {
    ...actual,
    hasCapabilityGrant: vi.fn(),
    companiesWithCapability: vi.fn(),
  };
});
vi.mock('@/lib/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/tasks')>();
  return { ...actual, listOpenTasksForCompany: vi.fn() };
});
vi.mock('@/lib/platform/attendance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/attendance')>();
  return {
    ...actual,
    attendanceSummaryForCompany: vi.fn(),
    currentAttendancePeriod: vi.fn(() => ({ start: '2026-07-25', end: '2026-08-24' })),
  };
});
vi.mock('@/lib/platform/folderTypes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/folderTypes')>();
  return { ...actual, createFolderType: vi.fn() };
});
vi.mock('@/lib/platform/alerts', () => ({ evaluateAlerts: vi.fn() }));
vi.mock('@/lib/platform/fileVisibility', () => ({
  wholesaleVisibleSections: vi.fn(async () => []),
}));
vi.mock('@/lib/platform/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/files')>();
  return {
    ...actual,
    listFilesForCompany: vi.fn(),
    listFilesForEmployee: vi.fn(),
  };
});

const { getSession } = await import('@/lib/session');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { wholesaleVisibleSections } = await import('@/lib/platform/fileVisibility');
const { FILE_SECTIONS } = await import('@/lib/platform/fileColors');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant, companiesWithCapability } = await import(
  '@/lib/platform/capabilityGrants'
);
const { listOpenTasksForCompany } = await import('@/lib/platform/tasks');
const { attendanceSummaryForCompany } = await import('@/lib/platform/attendance');
const { createFolderType } = await import('@/lib/platform/folderTypes');
const { listFilesForCompany, listFilesForEmployee } = await import(
  '@/lib/platform/files'
);

function companyIdRequest(companyId = COMPANY_A): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams({ company_id: companyId }) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    id: EMPLOYEE_ID,
    username: 'e',
    role: 'user',
  });
  vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
});

describe('GET /api/tasks/employee-overview — tasks.overview', () => {
  it('403s a plain employee with no grant', async () => {
    const { GET } = await import('@/app/api/tasks/employee-overview/route');
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await GET(companyIdRequest());
    expect(res.status).toBe(403);
    expect(hasCapabilityGrant).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      'tasks.overview'
    );
  });

  it('allows an employee explicitly granted tasks.overview', async () => {
    const { GET } = await import('@/app/api/tasks/employee-overview/route');
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(listOpenTasksForCompany).mockResolvedValue([] as never);
    const res = await GET(companyIdRequest());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe('GET /api/companies/:id/attendance/summary — attendance.viewAll', () => {
  it('403s a plain employee with no grant', async () => {
    const { GET } = await import(
      '@/app/api/companies/[id]/attendance/summary/route'
    );
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    const res = await GET(unusedRequest, { params: { id: COMPANY_A } });
    expect(res.status).toBe(403);
    expect(hasCapabilityGrant).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      'attendance.viewAll'
    );
  });

  it('allows an employee explicitly granted attendance.viewAll', async () => {
    const { GET } = await import(
      '@/app/api/companies/[id]/attendance/summary/route'
    );
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(attendanceSummaryForCompany).mockResolvedValue([] as never);
    const res = await GET(unusedRequest, { params: { id: COMPANY_A } });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/folder-types — company.folderTypes', () => {
  function req(body: unknown): NextRequest {
    return { json: async () => body } as unknown as NextRequest;
  }
  const BODY = { label_en: 'Trademark', label_ar: 'علامة تجارية', layout: 'case' };

  it('403s a plain employee with no grant in any company', async () => {
    const { POST } = await import('@/app/api/folder-types/route');
    vi.mocked(companiesWithCapability).mockResolvedValue(new Set());
    const res = await POST(req(BODY));
    expect(res.status).toBe(403);
    expect(companiesWithCapability).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      'company.folderTypes'
    );
  });

  it('allows an employee granted company.folderTypes in some company', async () => {
    const { POST } = await import('@/app/api/folder-types/route');
    vi.mocked(companiesWithCapability).mockResolvedValue(new Set([COMPANY_A]));
    vi.mocked(createFolderType).mockResolvedValue({
      key: 'trademark',
      labelEn: 'Trademark',
      labelAr: 'علامة تجارية',
      layout: 'case',
    } as never);
    const res = await POST(req(BODY));
    expect(res.status).toBe(201);
  });
});

describe('GET /api/companies/:id/contacts — company.contacts', () => {
  it('403s a plain employee with no grant', async () => {
    const { GET } = await import('@/app/api/companies/[id]/contacts/route');
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeSupabaseStub(() => ({ data: [] })).client as never
    );
    const res = await GET(unusedRequest, { params: { id: COMPANY_A } });
    expect(res.status).toBe(403);
    expect(hasCapabilityGrant).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      'company.contacts'
    );
  });

  it('allows an employee explicitly granted company.contacts', async () => {
    const { GET } = await import('@/app/api/companies/[id]/contacts/route');
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeSupabaseStub(() => ({ data: [] })).client as never
    );
    const res = await GET(unusedRequest, { params: { id: COMPANY_A } });
    expect(res.status).toBe(200);
  });
});

/**
 * Wholesale folder visibility is now FOUR grants, one per section, so these
 * cover the three shapes the route has to tell apart: none, some, and all.
 */
describe('GET /api/files — per-section wholesale visibility', () => {
  it('scopes to own-only folders when no section is granted', async () => {
    const { GET } = await import('@/app/api/files/route');
    vi.mocked(wholesaleVisibleSections).mockResolvedValue([]);
    vi.mocked(listFilesForEmployee).mockResolvedValue([
      { id: 'mine' },
    ] as never);
    const res = await GET(companyIdRequest());
    expect(res.status).toBe(200);
    expect(listFilesForEmployee).toHaveBeenCalledWith(COMPANY_A, EMPLOYEE_ID, []);
    expect(listFilesForCompany).not.toHaveBeenCalled();
  });

  /**
   * SOME sections: still the employee-scoped query — everything of theirs PLUS
   * those sections entire — and emphatically NOT the whole-company listing,
   * which would hand them the other three.
   */
  it('passes a partial section grant to the employee-scoped listing', async () => {
    const { GET } = await import('@/app/api/files/route');
    vi.mocked(wholesaleVisibleSections).mockResolvedValue(['expired'] as never);
    vi.mocked(listFilesForEmployee).mockResolvedValue([
      { id: 'mine' },
    ] as never);
    const res = await GET(companyIdRequest());
    expect(res.status).toBe(200);
    expect(listFilesForEmployee).toHaveBeenCalledWith(COMPANY_A, EMPLOYEE_ID, [
      'expired',
    ]);
    expect(listFilesForCompany).not.toHaveBeenCalled();
  });

  it('falls through to the whole-company view only when ALL sections are granted', async () => {
    const { GET } = await import('@/app/api/files/route');
    vi.mocked(wholesaleVisibleSections).mockResolvedValue([
      ...FILE_SECTIONS,
    ] as never);
    vi.mocked(listFilesForCompany).mockResolvedValue([
      { id: 'mine' },
      { id: 'theirs' },
    ] as never);
    const res = await GET(companyIdRequest());
    expect(res.status).toBe(200);
    expect(listFilesForCompany).toHaveBeenCalledWith(COMPANY_A, {
      userId: EMPLOYEE_ID,
      aggregate: true,
    });
    expect(listFilesForEmployee).not.toHaveBeenCalled();
    const data = (await res.json()) as { files: unknown[] };
    expect(data.files).toHaveLength(2);
  });
});
