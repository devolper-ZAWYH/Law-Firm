import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A misconfigured service account must never surface as a 500. The operator
 * needs to be told WHICH variable is wrong and how, without the key ever
 * appearing in a response or a log line.
 */

const ORIGINAL = { ...process.env };

async function freshDrive() {
  vi.resetModules();
  return import('@/lib/platform/drive');
}

describe('Drive credentials', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('reports unconfigured when nothing is set', async () => {
    const { listFolderDocuments, isDriveConfigured } = await freshDrive();
    expect(isDriveConfigured()).toBe(false);
    expect(await listFolderDocuments('folder1')).toEqual({
      ok: false,
      code: 'unconfigured',
    });
  });

  it('rejects a key that is not a PEM block, naming the problem', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'just-some-text';
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect((res as { detail: string }).detail).toContain('BEGIN PRIVATE KEY');
  });

  it('rejects a PKCS#1 key, which Google does not issue', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect((res as { detail: string }).detail).toContain('PKCS#8');
  });

  it('rejects a key pasted without line breaks', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----';
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect((res as { detail: string }).detail).toContain('line breaks');
  });

  it('accepts a bare key body with the BEGIN/END lines left off', async () => {
    // The armour reads as decoration, so it gets dropped. It is not decoration —
    // it is what identifies the bytes as PKCS#8 — so it is put back.
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'A'.repeat(600);
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    // Past the shape checks: it now fails on the bytes, not on the format.
    expect((res as { detail: string }).detail).not.toContain('PEM block');
  });

  it('still rejects a SHORT non-PEM value rather than dressing it as a key', async () => {
    // private_key_id is a 40-character hex string. Wrapping that in PEM armour
    // would turn an obvious mistake into a confusing one.
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'a3f9c2'.repeat(6);
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect((res as { detail: string }).detail).toContain('PEM block');
  });

  it('accepts the WHOLE service-account JSON pasted into the key variable', async () => {
    // The likeliest setup mistake: the JSON file is what Google hands you, and
    // only one of its fields is wanted. Both are taken from it instead.
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = JSON.stringify({
      type: 'service_account',
      client_email: 'svc@project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });
    const { isDriveConfigured, listFolderDocuments } = await freshDrive();
    expect(isDriveConfigured()).toBe(true);
    const res = await listFolderDocuments('folder1');
    // Past every shape check — it fails later, on the key's actual bytes.
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect((res as { detail: string }).detail).not.toContain('PEM block');
  });

  it('surfaces Google’s own rejection, and never the key', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    // A syntactically valid PKCS#8 PEM is required to reach the token call, so
    // importPKCS8 is stubbed — the point here is the HTTP failure path.
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
    // Both halves of the mint are stubbed: the point of this case is what
    // happens when GOOGLE rejects a well-formed request, not whether jose can
    // sign with a fake key.
    vi.doMock('jose', () => ({
      importPKCS8: vi.fn(async () => ({}) as never),
      SignJWT: class {
        setProtectedHeader() { return this; }
        setIssuer() { return this; }
        setAudience() { return this; }
        setIssuedAt() { return this; }
        setExpirationTime() { return this; }
        async sign() { return 'signed.jwt.assertion'; }
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
          { status: 400 }
        )
      )
    );
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    const detail = (res as { detail: string }).detail;
    expect(detail).toContain('invalid_grant');
    expect(detail).not.toContain('BEGIN PRIVATE KEY');
    vi.unstubAllGlobals();
  });

  it('strips surrounding quotes and unescapes \\n before parsing', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    // Quoted and escaped exactly as pasting from the JSON file produces.
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"';
    vi.doMock('jose', () => ({
      importPKCS8: vi.fn(async () => ({}) as never),
      SignJWT: class {
        setProtectedHeader() { return this; }
        setIssuer() { return this; }
        setAudience() { return this; }
        setIssuedAt() { return this; }
        setExpirationTime() { return this; }
        async sign() { return 'signed.jwt.assertion'; }
      },
    }));
    const fetchSpy = vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');

    // Reaching the token ENDPOINT at all is the assertion: it means the quotes
    // were stripped and the \\n unescaped, because a key still carrying either
    // would have been stopped by the shape checks before any request.
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('oauth2.googleapis.com');
    expect(res).toMatchObject({ ok: false, code: 'bad_credentials' });
    vi.unstubAllGlobals();
  });
});

/**
 * files.list does NOT fail for a folder the service account cannot see — the
 * query matches nothing and returns 200 with an empty array. Distinguishing
 * "empty" from "never shared with us" therefore needs a second call, and this
 * is the case that caught it on the live deployment: seventeen folders all
 * reported "ok, 0 documents" when none of them had been shared.
 */
describe('listFolderDocuments — empty versus not shared', () => {
  beforeEach(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@project.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    vi.doMock('jose', () => ({
      importPKCS8: vi.fn(async () => ({}) as never),
      SignJWT: class {
        setProtectedHeader() { return this; }
        setIssuer() { return this; }
        setAudience() { return this; }
        setIssuedAt() { return this; }
        setExpirationTime() { return this; }
        async sign() { return 'signed.jwt.assertion'; }
      },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Routes the token call, the folder probe and the listing to canned replies. */
  function stubDrive(opts: { probeStatus: number; files: unknown[] }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('oauth2.googleapis.com')) {
          return new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
            { status: 200 }
          );
        }
        // The probe fetches /files/<id>; the listing fetches /files?q=...
        if (/\/files\/[^?]+\?/.test(u)) {
          return new Response(JSON.stringify({ id: 'folder1' }), {
            status: opts.probeStatus,
          });
        }
        return new Response(JSON.stringify({ files: opts.files }), { status: 200 });
      })
    );
  }

  it('reports no_access when the folder itself is invisible', async () => {
    stubDrive({ probeStatus: 404, files: [] });
    const { listFolderDocuments } = await freshDrive();
    expect(await listFolderDocuments('folder1')).toEqual({
      ok: false,
      code: 'no_access',
    });
  });

  it('reports an EMPTY folder as ok, not as no_access', async () => {
    stubDrive({ probeStatus: 200, files: [] });
    const { listFolderDocuments } = await freshDrive();
    expect(await listFolderDocuments('folder1')).toEqual({ ok: true, documents: [] });
  });

  it('returns the documents when the folder is visible and populated', async () => {
    stubDrive({
      probeStatus: 200,
      files: [
        {
          id: 'd1',
          name: 'Statement of claim.pdf',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/d1/view',
          modifiedTime: '2026-08-01T10:00:00Z',
        },
      ],
    });
    const { listFolderDocuments } = await freshDrive();
    const res = await listFolderDocuments('folder1');
    expect(res).toMatchObject({ ok: true });
    expect((res as { documents: { name: string }[] }).documents[0].name).toBe(
      'Statement of claim.pdf'
    );
  });
});
