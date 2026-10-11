import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
  unusedRequest,
} from '../helpers/platformUser';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * P0-1 regression suite — GET /api/companies/:id/settings must not disclose the
 * company's Telegram bot token to anyone who cannot also change it.
 *
 * The token grants full control of the firm's bot: `getUpdates` dumps the whole
 * alert-channel history (client names, opponent names, task titles — see the
 * message built in lib/platform/alerts.ts), and `sendMessage` posts as the firm.
 * Before the fix, `roleInCompany(pu, id) !== null` was the only gate, so ANY
 * member — including a first-day employee — could read it with a single curl.
 */

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
// The route now also loads the company's managers, to offer the admin a list
// to pick the approving manager from. Irrelevant to credential exposure, but
// it has to resolve or the handler never reaches the assertions below.
vi.mock('@/lib/platform/access', () => ({
  listCompanyManagers: vi.fn(async () => []),
}));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  // Keep the REAL canAdmin / roleInCompany — they are the predicates under test.
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});

const { getSession } = await import('@/lib/session');
const { getSupabaseAdmin } = await import('@/lib/supabase');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { GET } = await import('@/app/api/companies/[id]/settings/route');

const REAL_TOKEN = '7654321:AAH-REAL-BOT-TOKEN-DO-NOT-LEAK';
const REAL_CHAT_ID = '-1001234567890';

const COMPANY_ROW = {
  working_days: [0, 1, 2, 3, 4],
  days_per_color_step: 3,
  telegram_bot_token: REAL_TOKEN,
  telegram_chat_id: REAL_CHAT_ID,
  alerts_enabled: true,
  telegram_enabled: true,
};

interface SettingsBody {
  ok: boolean;
  error?: string;
  settings?: {
    working_days: number[];
    days_per_color_step: number;
    telegram_bot_token: string;
    telegram_chat_id: string;
    alerts_enabled: boolean;
    telegram_enabled: boolean;
  };
}

function stubDb() {
  const stub = makeSupabaseStub(() => ({ data: COMPANY_ROW }));
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
  return stub;
}

async function callGet(companyId = COMPANY_A) {
  const res = await GET(unusedRequest, { params: { id: companyId } });
  return { res, body: (await res.json()) as SettingsBody };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    id: 'session-user',
    username: 'u',
    role: 'user',
  });
  stubDb();
});

describe('GET /api/companies/:id/settings — Telegram credential exposure', () => {
  it('gives a global admin the real bot token (they are the only role that can edit it)', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());

    const { res, body } = await callGet();

    expect(res.status).toBe(200);
    expect(body.settings?.telegram_bot_token).toBe(REAL_TOKEN);
    expect(body.settings?.telegram_chat_id).toBe(REAL_CHAT_ID);
  });

  it('does NOT leak the bot token to a plain employee of the company', async () => {
    // The P0-1 exploit: a first-day paralegal with one employee membership
    // curls this endpoint with the company_id already embedded in their own
    // dashboard props.
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());

    const { res, body } = await callGet();

    expect(res.status).toBe(200);
    expect(body.settings?.telegram_bot_token).toBe('');
    expect(body.settings?.telegram_chat_id).toBe('');
    expect(JSON.stringify(body)).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(body)).not.toContain(REAL_CHAT_ID);
  });

  it('does NOT leak the bot token to a manager, who cannot edit it either', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());

    const { res, body } = await callGet();

    expect(res.status).toBe(200);
    expect(body.settings?.telegram_bot_token).toBe('');
    expect(JSON.stringify(body)).not.toContain(REAL_TOKEN);
  });

  it('still returns every non-secret setting to a plain employee', async () => {
    // Guards the functional contract: InstructionsGuide.tsx reads
    // days_per_color_step from this endpoint as an ordinary employee, so the
    // fix must not lock the whole route down to admins.
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());

    const { body } = await callGet();

    expect(body.settings?.days_per_color_step).toBe(3);
    expect(body.settings?.working_days).toEqual([0, 1, 2, 3, 4]);
    expect(body.settings?.alerts_enabled).toBe(true);
    expect(body.settings?.telegram_enabled).toBe(true);
  });

  it('keeps the response SHAPE identical for every role', async () => {
    // SettingsView.tsx types both credentials as `string` and binds them to
    // controlled inputs. Omitting the keys instead of blanking them would make
    // those inputs uncontrolled, so the keys must always be present strings.
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const asAdmin = (await callGet()).body;

    vi.clearAllMocks();
    stubDb();
    vi.mocked(getSession).mockResolvedValue({
      id: 'session-user',
      username: 'u',
      role: 'user',
    });
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const asEmployee = (await callGet()).body;

    expect(Object.keys(asEmployee.settings ?? {}).sort()).toEqual(
      Object.keys(asAdmin.settings ?? {}).sort()
    );
    expect(typeof asEmployee.settings?.telegram_bot_token).toBe('string');
    expect(typeof asEmployee.settings?.telegram_chat_id).toBe('string');
  });

  it('refuses a non-member outright (company isolation is unchanged)', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());

    const { res, body } = await callGet();

    expect(res.status).toBe(403);
    expect(body.settings).toBeUndefined();
  });

  it('refuses an unauthenticated caller', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const { res, body } = await callGet();

    expect(res.status).toBe(401);
    expect(body.settings).toBeUndefined();
  });
});
