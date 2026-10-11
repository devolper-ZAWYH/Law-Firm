import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  employeeUser,
  managerUser,
  outsiderUser,
  unusedRequest,
} from '../helpers/platformUser';

/**
 * The service account can read EVERY Drive folder shared with it, so Google
 * enforces nothing on our behalf — this route is the only thing standing
 * between an employee and another matter's documents. These cases exist for
 * that reason first, and for the empty-state wording second.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/files', () => ({
  getFileById: vi.fn(),
  isFileAssignedToUser: vi.fn(),
}));
vi.mock('@/lib/platform/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/drive')>();
  // parseDriveFolderId is pure and covered by its own test — keep the real one
  // so the route is exercised against real link shapes.
  return { ...actual, listFolderDocuments: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { getFileById, isFileAssignedToUser } = await import('@/lib/platform/files');
const { listFolderDocuments } = await import('@/lib/platform/drive');
const route = await import('@/app/api/files/[id]/documents/route');

const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ctx = { params: { id: FILE_ID } };
const FOLDER_URL = 'https://drive.google.com/drive/folders/1AbC_dEF-123';

function fileWithLink(driveLink: string | null) {
  return { id: FILE_ID, companyId: COMPANY_A, driveLink } as never;
}

describe('GET /api/files/:id/documents — who may read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(getFileById).mockResolvedValue(fileWithLink(FOLDER_URL));
    vi.mocked(isFileAssignedToUser).mockResolvedValue(false);
    vi.mocked(listFolderDocuments).mockResolvedValue({ ok: true, documents: [] });
  });

  it('404s an employee NOT assigned to the folder, without calling Drive', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await route.GET(unusedRequest, ctx);
    expect(res.status).toBe(404);
    expect(listFolderDocuments).not.toHaveBeenCalled();
  });

  it('404s someone from another company entirely', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    expect((await route.GET(unusedRequest, ctx)).status).toBe(404);
    expect(listFolderDocuments).not.toHaveBeenCalled();
  });

  it('allows an employee who IS assigned to the folder', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(isFileAssignedToUser).mockResolvedValue(true);
    expect((await route.GET(unusedRequest, ctx)).status).toBe(200);
    expect(listFolderDocuments).toHaveBeenCalledWith('1AbC_dEF-123');
  });

  it('allows a manager without needing a folder assignment', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    expect((await route.GET(unusedRequest, ctx)).status).toBe(200);
  });

  it('401s when unauthenticated', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await route.GET(unusedRequest, ctx)).status).toBe(401);
  });
});

describe('GET /api/files/:id/documents — the ways it comes back empty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    vi.mocked(isFileAssignedToUser).mockResolvedValue(true);
    vi.mocked(listFolderDocuments).mockResolvedValue({ ok: true, documents: [] });
  });

  it('reports no_link for an empty Drive field', async () => {
    vi.mocked(getFileById).mockResolvedValue(fileWithLink(null));
    const body = await (await route.GET(unusedRequest, ctx)).json();
    expect(body).toMatchObject({ ok: true, state: 'no_link', documents: [] });
    expect(listFolderDocuments).not.toHaveBeenCalled();
  });

  it('reports not_a_drive_link, echoing the stored text', async () => {
    vi.mocked(getFileById).mockResolvedValue(fileWithLink('www.albaker.qa'));
    const body = await (await route.GET(unusedRequest, ctx)).json();
    expect(body).toMatchObject({
      state: 'not_a_drive_link',
      storedValue: 'www.albaker.qa',
    });
    expect(listFolderDocuments).not.toHaveBeenCalled();
  });

  it('passes through unconfigured', async () => {
    vi.mocked(getFileById).mockResolvedValue(fileWithLink(FOLDER_URL));
    vi.mocked(listFolderDocuments).mockResolvedValue({
      ok: false,
      code: 'unconfigured',
    });
    const body = await (await route.GET(unusedRequest, ctx)).json();
    expect(body).toMatchObject({ ok: true, state: 'unconfigured', documents: [] });
  });

  it('passes through no_access — the folder is not shared with us', async () => {
    vi.mocked(getFileById).mockResolvedValue(fileWithLink(FOLDER_URL));
    vi.mocked(listFolderDocuments).mockResolvedValue({ ok: false, code: 'no_access' });
    const body = await (await route.GET(unusedRequest, ctx)).json();
    expect(body).toMatchObject({ state: 'no_access' });
  });

  it('returns the documents and the folder link on success', async () => {
    vi.mocked(getFileById).mockResolvedValue(fileWithLink(FOLDER_URL));
    vi.mocked(listFolderDocuments).mockResolvedValue({
      ok: true,
      documents: [
        {
          id: 'doc1',
          name: 'Statement of claim.pdf',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/doc1/view',
          modifiedTime: '2026-08-01T10:00:00Z',
          isFolder: false,
        },
      ],
    });
    const body = await (await route.GET(unusedRequest, ctx)).json();
    expect(body.state).toBe('ok');
    expect(body.folderLink).toBe(FOLDER_URL);
    expect(body.documents[0]).toMatchObject({
      name: 'Statement of claim.pdf',
      webViewLink: 'https://drive.google.com/file/d/doc1/view',
    });
  });
});
