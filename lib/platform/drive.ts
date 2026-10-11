import 'server-only';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * GOOGLE DRIVE — listing the documents in a folder's linked Drive folder.
 *
 * AUTH: one SERVICE ACCOUNT for the whole firm, not per-user OAuth. The folders
 * are shared with the service account's email; the server mints a signed JWT,
 * exchanges it for an access token, and reads with that. No consent screen, no
 * per-user tokens to store or refresh, and every employee who may see a folder
 * sees the same document list.
 *
 * The consequence, stated plainly: the service account can read any folder it
 * has been shared with, so authorisation is OURS to enforce, not Google's. The
 * route gates on the same rule that already governs the Drive LINK itself —
 * see app/api/files/[id]/documents/route.ts.
 *
 * NO NEW DEPENDENCY: the token is signed with `jose`, already used for sessions,
 * rather than pulling in googleapis for one REST call.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
/** Read-only: this integration never needs to modify anything in Drive. */
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export type DriveLinkParse =
  | { kind: 'folder'; folderId: string }
  /** The field is empty — no Drive folder has been linked. */
  | { kind: 'none' }
  /**
   * The field holds something, but it is not a Drive FOLDER link. In this
   * database that is common: it has been used as a free-text note
   * ("www.albaker.qa", "not now", a sentence in Arabic), so the distinction is
   * worth surfacing rather than reporting as "no link".
   */
  | { kind: 'not_a_drive_link'; raw: string };

const FOLDER_RE =
  /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/;

/** Pull the folder id out of whatever is stored in files.drive_link. */
export function parseDriveFolderId(link: string | null | undefined): DriveLinkParse {
  const raw = (link ?? '').trim();
  if (!raw) return { kind: 'none' };
  const m = raw.match(FOLDER_RE);
  if (m && m[1]) return { kind: 'folder', folderId: m[1] };
  return { kind: 'not_a_drive_link', raw };
}

export interface DriveDocument {
  id: string;
  name: string;
  mimeType: string;
  /** Where clicking it should take the reader — the file's own page in Drive. */
  webViewLink: string;
  modifiedTime: string | null;
  /** True for a sub-folder, so the UI can show it differently. */
  isFolder: boolean;
}

export type DriveListResult =
  | { ok: true; documents: DriveDocument[] }
  | {
      ok: false;
      code:
        /** No service-account credentials configured on this deployment. */
        | 'unconfigured'
        /**
         * Credentials ARE configured but Google rejected them, or the key could
         * not be parsed. Separate from 'drive_error' because the fix is
         * entirely different: correct the env vars, not the sharing.
         */
        | 'bad_credentials'
        /** The folder is not shared with the service account, or is gone. */
        | 'no_access'
        | 'drive_error';
      /** Safe to show: describes the shape of the problem, never the key. */
      detail?: string;
    };

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be reused. */
  expiresAt: number;
}
let cached: CachedToken | null = null;

function credentials(): { email: string; privateKey: string } | null {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!rawKey) return null;

  let privateKey = rawKey.trim();

  // THE WHOLE JSON KEY FILE, pasted in. An easy mistake — the file is what
  // Google hands you, and only one of its fields is wanted — so take both
  // fields from it rather than complaining. The email variable, if it was set
  // separately, still wins.
  if (privateKey.startsWith('{')) {
    try {
      const parsed = JSON.parse(privateKey) as {
        private_key?: string;
        client_email?: string;
      };
      if (parsed.private_key) {
        privateKey = parsed.private_key;
        if (!email && parsed.client_email) email = parsed.client_email.trim();
      }
    } catch {
      /* not JSON after all — fall through to the shape checks */
    }
  }

  if (!email) return null;
  // Pasting from the JSON file often brings the surrounding quotes along.
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  // Railway (and most env UIs) store the PEM with literal \n sequences rather
  // than real newlines; importPKCS8 needs the real thing.
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

  // A BARE KEY BODY — the base64 with the BEGIN/END lines left off. Easy to do:
  // they read as decoration rather than as part of the value. They are not: the
  // armour is what identifies the bytes as PKCS#8, so without it nothing can
  // parse. Put it back rather than failing.
  //
  // Guarded on length and alphabet so a wrong-but-short field (private_key_id
  // is a 40-character hex string) is still reported as wrong instead of being
  // dressed up as a key.
  if (!privateKey.includes('BEGIN')) {
    const body = privateKey.replace(/\s+/g, '');
    if (body.length > 500 && /^[A-Za-z0-9+/=]+$/.test(body)) {
      const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
      privateKey = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
    }
  }

  return { email, privateKey };
}

/**
 * Why the configured credentials cannot be used, in words a person can act on.
 * Never includes the key itself — only its shape.
 */
function describeKeyProblem(privateKey: string): string | null {
  if (!privateKey.includes('BEGIN')) {
    return 'The private key does not look like a PEM block — it should start with "-----BEGIN PRIVATE KEY-----".';
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    return 'The private key is not in PKCS#8 form. Use the `private_key` field from the service account JSON, which begins "-----BEGIN PRIVATE KEY-----".';
  }
  if (!privateKey.includes('\n')) {
    return 'The private key has no line breaks. Paste it with its newlines, or with literal \\n sequences.';
  }
  return null;
}

/** True when this deployment has Drive credentials at all. */
export function isDriveConfigured(): boolean {
  return credentials() !== null;
}

/**
 * A Google access token for the service account, cached until shortly before it
 * expires. Google issues these for an hour; the 60-second margin means a token
 * is never used in the moment it lapses.
 */
type TokenResult =
  | { ok: true; token: string }
  | { ok: false; code: 'unconfigured' | 'bad_credentials'; detail?: string };

async function getAccessToken(): Promise<TokenResult> {
  const creds = credentials();
  if (!creds) return { ok: false, code: 'unconfigured' };
  if (cached && Date.now() < cached.expiresAt) {
    return { ok: true, token: cached.token };
  }

  const shapeProblem = describeKeyProblem(creds.privateKey);
  if (shapeProblem) {
    return { ok: false, code: 'bad_credentials', detail: shapeProblem };
  }

  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(creds.privateKey, 'RS256');
  } catch (err) {
    // A malformed key must not surface as a 500 — the operator needs to be told
    // which of the two variables to fix.
    console.error('Drive private key could not be imported:', err);
    return {
      ok: false,
      code: 'bad_credentials',
      detail:
        'The private key could not be read. Check GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY was copied whole, including the BEGIN and END lines.',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    // Signing and the exchange share this guard: a key that PARSES but cannot
    // sign throws here, not in importPKCS8, and an unguarded throw becomes a
    // bare 500 that tells the operator nothing.
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(creds.email)
      .setAudience(TOKEN_ENDPOINT)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      // Google's token endpoint is a third party on the critical path of a
      // folder listing. Bounded so a slow one degrades the Drive panel instead
      // of holding the whole request open.
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error('Drive token request failed:', err);
    return {
      ok: false,
      code: 'bad_credentials',
      detail:
        'The service account could not be used to sign a request. Check GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is the complete `private_key` value from the JSON key file.',
    };
  }
  if (!res.ok) {
    const body = await res.text();
    console.error('Drive token exchange failed:', res.status, body);
    // Google's own words are the most useful thing here — "invalid_grant"
    // means the clock or the key is wrong, "invalid_client" means the email
    // does not match the key. Neither leaks anything secret.
    let described = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as {
        error?: string;
        error_description?: string;
      };
      if (parsed.error) {
        described = parsed.error_description
          ? `${parsed.error}: ${parsed.error_description}`
          : parsed.error;
      }
    } catch {
      /* keep the raw snippet */
    }
    return {
      ok: false,
      code: 'bad_credentials',
      detail: `Google rejected the service account (${described}).`,
    };
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    return {
      ok: false,
      code: 'bad_credentials',
      detail: 'Google returned no access token.',
    };
  }
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  return { ok: true, token: cached.token };
}

/**
 * The documents directly inside `folderId`, folders first then by name.
 *
 * Trashed items are excluded. `supportsAllDrives` is set so a folder living in
 * a Shared Drive works the same as one in My Drive — otherwise the call
 * silently returns nothing for exactly the folders a firm is most likely to use.
 */
export async function listFolderDocuments(
  folderId: string
): Promise<DriveListResult> {
  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) return tokenResult;
  const token = tokenResult.token;

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime)',
    orderBy: 'folder,name',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  // TWO CALLS, AND BOTH ARE NEEDED.
  //
  // files.list does NOT fail for a folder the service account cannot see: the
  // query simply matches nothing and returns 200 with an empty array. So a
  // listing on its own cannot tell "this folder is empty" from "this folder was
  // never shared with us" — which is the single most likely state during setup,
  // and the one most in need of its own message.
  //
  // files.get on the folder itself DOES 404 when it is not visible, so it is
  // the probe that distinguishes them. They run together; the listing is
  // discarded if the probe says we cannot see the folder at all.
  const probeParams = new URLSearchParams({
    fields: 'id',
    supportsAllDrives: 'true',
  });
  // Both bounded — see the token fetch above. These run in parallel, so the
  // pair costs one timeout, not two.
  const [probe, res] = await Promise.all([
    fetch(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(folderId)}?${probeParams}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    }),
    fetch(`${DRIVE_FILES_ENDPOINT}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    }),
  ]);

  if (probe.status === 404 || probe.status === 403) {
    return { ok: false, code: 'no_access' };
  }
  if (res.status === 404 || res.status === 403) {
    return { ok: false, code: 'no_access' };
  }
  if (!res.ok) {
    const detail = await res.text();
    console.error('Drive list failed:', res.status, detail);
    return { ok: false, code: 'drive_error' };
  }

  const data = (await res.json()) as {
    files?: {
      id: string;
      name: string;
      mimeType: string;
      webViewLink?: string;
      modifiedTime?: string;
    }[];
  };
  const documents: DriveDocument[] = (data.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    webViewLink:
      f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
    modifiedTime: f.modifiedTime ?? null,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
  }));
  return { ok: true, documents };
}
