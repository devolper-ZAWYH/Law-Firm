import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  adminUser,
  employeeUser,
  managerUser,
  unusedRequest,
} from '../helpers/platformUser';
import { makeSupabaseStub } from '../helpers/supabase';
import type { NextRequest } from 'next/server';

/**
 * An employee must see ONLY the folders assigned to them — an access grant, or
 * a task assigned to them — no matter which extra membership permissions they
 * hold.
 *
 * Before this, ANY single grant (can_create_file, can_edit_file, …) switched an
 * employee onto the company-wide folder list, so giving someone permission to
 * create a folder also exposed every other client matter in the firm. Those
 * grants now govern what an employee may DO with a folder, never which folders
 * exist for them.
 *
 * Managers and admins are unaffected and still see the whole company.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/alerts', () => ({ evaluateAlerts: vi.fn() }));
vi.mock('@/lib/platform/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/files')>();
  return {
    ...actual,
    listFilesForCompany: vi.fn(),
    listFilesForEmployee: vi.fn(),
    getFileById: vi.fn(),
    isFileAssignedToUser: vi.fn(),
  };
});

const { getSession } = await import('@/lib/session');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getPlatformUser } = await import('@/lib/platform/auth');
const {
  listFilesForCompany,
  listFilesForEmployee,
  getFileById,
  isFileAssignedToUser,
} = await import('@/lib/platform/files');
const { GET: LIST } = await import('@/app/api/files/route');
const { GET: DETAIL } = await import('@/app/api/files/[id]/route');

const MINE = { id: 'file-mine', companyId: COMPANY_A };
const THEIRS = { id: 'file-theirs', companyId: COMPANY_A };

/** An employee holding every extra permission — the worst case for leakage. */
function fullyPermittedEmployee() {
  const pu = employeeUser();
  pu.companies = pu.companies.map((c) => ({
    ...c,
    hasFilePermission: true,
    hasAttendancePermission: true,
  }));
  return pu;
}

function listRequest(companyId = COMPANY_A): NextRequest {
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
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    makeSupabaseStub(() => ({ data: null })).client as never
  );
  vi.mocked(listFilesForCompany).mockResolvedValue([
    MINE,
    THEIRS,
  ] as never);
  vi.mocked(listFilesForEmployee).mockResolvedValue([MINE] as never);
  vi.mocked(isFileAssignedToUser).mockResolvedValue(false);
});

describe('GET /api/files — the Folders list', () => {
  it('gives a permitted employee ONLY their own folders', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(fullyPermittedEmployee());

    const res = await LIST(listRequest());
    const body = (await res.json()) as { ok: boolean; files: { id: string }[] };

    expect(res.status).toBe(200);
    expect(body.files.map((f) => f.id)).toEqual(['file-mine']);
  });

  it('never reaches the company-wide listing for an employee', async () => {
    // The status code alone would not catch a regression that fetched every
    // folder and filtered client-side.
    vi.mocked(getPlatformUser).mockResolvedValue(fullyPermittedEmployee());

    await LIST(listRequest());

    expect(listFilesForCompany).not.toHaveBeenCalled();
    // The third argument is the set of sections this employee may see
    // WHOLESALE — empty here, because holding every membership permission
    // still grants no section. That is the whole point of the test: what an
    // employee may DO with a folder must never widen which folders exist for
    // them.
    expect(listFilesForEmployee).toHaveBeenCalledWith(COMPANY_A, EMPLOYEE_ID, []);
  });

  it('scopes an employee with NO extra permissions the same way', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());

    const res = await LIST(listRequest());
    const body = (await res.json()) as { files: { id: string }[] };

    expect(body.files.map((f) => f.id)).toEqual(['file-mine']);
  });

  it('still gives a MANAGER the whole company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const res = await LIST(listRequest());
    const body = (await res.json()) as { files: { id: string }[] };

    expect(body.files.map((f) => f.id)).toEqual(['file-mine', 'file-theirs']);
    expect(listFilesForCompany).toHaveBeenCalled();
  });

  it('still gives an ADMIN the whole company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());

    const res = await LIST(listRequest());
    const body = (await res.json()) as { files: { id: string }[] };

    expect(body.files.map((f) => f.id)).toEqual(['file-mine', 'file-theirs']);
  });

  it('refuses a company the caller has no membership in', async () => {
    const { outsiderUser } = await import('../helpers/platformUser');
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());

    const res = await LIST(listRequest());

    expect(res.status).toBe(403);
  });
});

describe('GET /api/files/:id — opening a folder directly', () => {
  it("404s when a permitted employee asks for someone else's folder by id", async () => {
    // The list is scoped, so the id has to be guessed or remembered — the API
    // must refuse it regardless.
    vi.mocked(getPlatformUser).mockResolvedValue(fullyPermittedEmployee());
    vi.mocked(getFileById).mockResolvedValue(THEIRS as never);
    vi.mocked(isFileAssignedToUser).mockResolvedValue(false);

    const res = await DETAIL(unusedRequest, { params: { id: THEIRS.id } });

    expect(res.status).toBe(404);
  });

  it('lets an employee open a folder that IS theirs', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(getFileById).mockResolvedValue(MINE as never);
    vi.mocked(isFileAssignedToUser).mockResolvedValue(true);

    const res = await DETAIL(unusedRequest, { params: { id: MINE.id } });

    expect(res.status).toBe(200);
  });

  it('does not make a manager prove assignment', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(getFileById).mockResolvedValue(THEIRS as never);

    const res = await DETAIL(unusedRequest, { params: { id: THEIRS.id } });

    expect(res.status).toBe(200);
    expect(isFileAssignedToUser).not.toHaveBeenCalled();
  });
});
