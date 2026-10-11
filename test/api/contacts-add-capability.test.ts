import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  EMPLOYEE_ID,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
  unusedRequest,
} from '../helpers/platformUser';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * POST /api/companies/:id/contacts — "add people to CRM".
 *
 * Was ADMIN ONLY. Now: admin, any MANAGER of the company, or an employee
 * granted 'company.contactsAdd' — and that grant can be handed out in
 * "requires approval" form, in which case nothing is written until the
 * approving manager says yes.
 */

let stub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  // The real canAdmin / roleInCompany are the predicates under test.
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/permissions', () => ({
  canCreateFile: vi.fn(async () => false),
  canEditFileCore: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/approvals', () => ({ gateAction: vi.fn() }));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { gateAction } = await import('@/lib/platform/approvals');
const { POST, GET } = await import('@/app/api/companies/[id]/contacts/route');

const ctx = { params: { id: COMPANY_A } };

function req(body: Record<string, unknown> = { name_en: 'Acme Trading' }) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

/** Did the handler actually write a contact row? */
function insertedContact(): boolean {
  return stub.queries.some(
    (q) => q.table === 'contacts' && q.calls.some((c) => c.method === 'insert')
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The LIST query settles by awaiting the builder and expects an array; the
  // INSERT settles via .single() and expects one row.
  stub = makeSupabaseStub((q) =>
    q.calls.some((c) => c.method === 'order')
      ? { data: [{ id: 'contact-1', created_at: '2026-08-18T10:00:00Z' }] }
      : { data: { id: 'contact-1', created_at: '2026-08-18T10:00:00Z' } }
  );
  vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
  vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
  vi.mocked(gateAction).mockResolvedValue({ kind: 'run' } as never);
});

describe('adding a CRM contact', () => {
  it('allows an admin', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(insertedContact()).toBe(true);
  });

  it('allows a MANAGER of the company (this is the new part)', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(insertedContact()).toBe(true);
    // A manager's authority is their role, so the gate must treat them as
    // privileged and never look for a grant flag.
    expect(vi.mocked(gateAction).mock.calls[0][0].isPrivileged).toBe(true);
  });

  it('refuses a plain employee with no grant', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(insertedContact()).toBe(false);
  });

  it('allows an employee granted company.contactsAdd', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(insertedContact()).toBe(true);
    expect(vi.mocked(hasCapabilityGrant)).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      'company.contactsAdd'
    );
  });

  it('refuses someone from another company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(insertedContact()).toBe(false);
  });

  it('HOLDS a gated grant at 202 and writes NOTHING', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-9' },
    } as never);

    const res = await POST(req({ name_en: 'Acme', name_ar: 'أكمي' }), ctx);
    expect(res.status).toBe(202);
    expect(insertedContact()).toBe(false);
    expect((await res.json()).code).toBe('pending_approval');
  });

  it('parks the contact fields, so approving creates exactly what was asked', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-9' },
    } as never);

    await POST(
      req({ name_en: 'Acme', name_ar: 'أكمي', email: 'a@b.co', phone: '5551234' }),
      ctx
    );
    expect(vi.mocked(gateAction).mock.calls[0][0].payload).toMatchObject({
      nameEn: 'Acme',
      nameAr: 'أكمي',
      email: 'a@b.co',
      phone: '5551234',
    });
  });

  it('refuses (409) when gated with no approving manager assigned', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(gateAction).mockResolvedValue({ kind: 'no_approver' } as never);

    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect(insertedContact()).toBe(false);
    expect((await res.json()).code).toBe('no_approver');
  });

  it('still requires a name', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await POST(req({ name_en: '', name_ar: '' }), ctx);
    expect(res.status).toBe(400);
    expect(insertedContact()).toBe(false);
  });
});

describe('reading the CRM directory', () => {
  /**
   * Regression: managers gained the CRM sidebar link and the ability to ADD a
   * contact, but the LIST gate was not widened with them — so clicking CRM
   * answered 403 twice and the page rendered empty. Whoever may write to the
   * directory has to be able to read it, or they cannot see what is already
   * there and will enter the same client twice.
   */
  it('allows a MANAGER of the company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await GET(unusedRequest, ctx);
    expect(res.status).toBe(200);
  });

  it('allows an admin', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    expect((await GET(unusedRequest, ctx)).status).toBe(200);
  });

  it('allows an employee granted company.contacts', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockImplementation(
      async (_u, _c, key) => key === 'company.contacts'
    );
    expect((await GET(unusedRequest, ctx)).status).toBe(200);
  });

  it('allows an employee granted only company.contactsAdd', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockImplementation(
      async (_u, _c, key) => key === 'company.contactsAdd'
    );
    expect((await GET(unusedRequest, ctx)).status).toBe(200);
  });

  it('still refuses a plain employee with neither', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    expect((await GET(unusedRequest, ctx)).status).toBe(403);
  });

  it('still refuses someone from another company', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
    expect((await GET(unusedRequest, ctx)).status).toBe(403);
  });
});
