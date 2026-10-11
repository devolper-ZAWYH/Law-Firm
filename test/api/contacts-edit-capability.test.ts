import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_A,
  COMPANY_B,
  EMPLOYEE_ID,
  adminUser,
  employeeUser,
  managerUser,
  outsiderUser,
} from '../helpers/platformUser';
import { makeSupabaseStub, used } from '../helpers/supabase';

/**
 * PATCH /api/contacts/:id — "edit a CRM entry".
 *
 * Was ADMIN ONLY, and — because admin power is global — the route carried no
 * company check at all. Opening it to managers and to employees granted
 * 'company.contactsEdit' means the contact's OWN company has to be resolved
 * first and the caller's role checked against it; the cross-company case below
 * is the one that would be a real hole without that step.
 *
 * DELETE is deliberately NOT part of this and stays admin-only.
 */

let stub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => stub.client }));
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  // The real canAdmin / roleInCompany are the predicates under test.
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, getPlatformUser: vi.fn() };
});
vi.mock('@/lib/platform/capabilityGrants', () => ({
  hasCapabilityGrant: vi.fn(async () => false),
}));
vi.mock('@/lib/platform/approvals', () => ({ gateAction: vi.fn() }));

const { getSession } = await import('@/lib/session');
const { getPlatformUser } = await import('@/lib/platform/auth');
const { hasCapabilityGrant } = await import('@/lib/platform/capabilityGrants');
const { gateAction } = await import('@/lib/platform/approvals');
const { PATCH, DELETE } = await import('@/app/api/contacts/[id]/route');

const CONTACT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ctx = { params: { id: CONTACT_ID } };

function req(body: Record<string, unknown> = { name_en: 'Acme Trading' }) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

/** Did the handler actually write to the contact row? */
function updatedContact(): boolean {
  return stub.queries.some((q) => q.table === 'contacts' && used(q, 'update'));
}

/**
 * The owning company the stubbed lookup reports. The route reads
 * `company_id` before deciding anything, so this is what decides the answer.
 */
function ownedBy(companyId: string) {
  stub = makeSupabaseStub((q) =>
    used(q, 'update')
      ? { data: { id: CONTACT_ID, created_at: '2026-08-18T10:00:00Z' } }
      : { data: { company_id: companyId } }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ownedBy(COMPANY_A);
  vi.mocked(getSession).mockResolvedValue({ sub: EMPLOYEE_ID } as never);
  vi.mocked(hasCapabilityGrant).mockResolvedValue(false);
  vi.mocked(gateAction).mockResolvedValue({ kind: 'run' } as never);
});

describe('editing a CRM contact', () => {
  it('allows an admin', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(200);
    expect(updatedContact()).toBe(true);
  });

  it('allows a MANAGER of the company (this is the new part)', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(200);
    expect(updatedContact()).toBe(true);
    // A manager's authority is their role, so the gate must treat them as
    // privileged and never look for a grant flag.
    expect(vi.mocked(gateAction).mock.calls[0][0].isPrivileged).toBe(true);
  });

  it('refuses a plain employee with no grant', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(403);
    expect(updatedContact()).toBe(false);
  });

  it('allows an employee granted company.contactsEdit', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(200);
    expect(updatedContact()).toBe(true);
    expect(vi.mocked(hasCapabilityGrant)).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      COMPANY_A,
      'company.contactsEdit'
    );
  });

  it('refuses a MANAGER of a DIFFERENT company', async () => {
    // The hole this route would have had without a company lookup: manager of
    // A, contact belongs to B, id guessed or copied from a URL.
    ownedBy(COMPANY_B);
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(403);
    expect(updatedContact()).toBe(false);
  });

  it('refuses someone with no membership at all', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(outsiderUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(403);
    expect(updatedContact()).toBe(false);
  });

  it('scopes the write by company as well as by id', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    await PATCH(req(), ctx);
    const write = stub.queries.find((q) => used(q, 'update'));
    const eqs = write?.calls.filter((c) => c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['id', CONTACT_ID],
        ['company_id', COMPANY_A],
      ])
    );
  });

  it('HOLDS a gated grant at 202 and writes NOTHING', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    vi.mocked(gateAction).mockResolvedValue({
      kind: 'held',
      request: { id: 'req-1' },
    } as never);
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(202);
    expect(updatedContact()).toBe(false);
  });

  it('parks the contact id, so the approved edit knows what to change', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    await PATCH(req(), ctx);
    const call = vi.mocked(gateAction).mock.calls[0][0];
    expect(call.capabilityKey).toBe('company.contactsEdit');
    expect((call.payload as { contactId?: string }).contactId).toBe(CONTACT_ID);
  });

  it('still rejects a nameless edit', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await PATCH(req({ name_en: '  ', name_ar: '' }), ctx);
    expect(res.status).toBe(400);
    expect(updatedContact()).toBe(false);
  });

  it('does not leak whether an unknown contact exists', async () => {
    // No company_id came back — answer 403, the same as "not yours", rather
    // than a 404 that confirms the id is real.
    stub = makeSupabaseStub(() => ({ data: null }));
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(403);
  });
});

describe('deleting a CRM contact stays admin-only', () => {
  it('allows an admin', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(adminUser());
    const res = await DELETE({} as never, ctx);
    expect(res.status).toBe(200);
  });

  it('refuses a MANAGER — edit was widened, delete deliberately was not', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(managerUser());
    const res = await DELETE({} as never, ctx);
    expect(res.status).toBe(403);
  });

  it('refuses an employee holding company.contactsEdit', async () => {
    vi.mocked(getPlatformUser).mockResolvedValue(employeeUser());
    vi.mocked(hasCapabilityGrant).mockResolvedValue(true);
    const res = await DELETE({} as never, ctx);
    expect(res.status).toBe(403);
    expect(
      stub.queries.some((q) => q.table === 'contacts' && used(q, 'delete'))
    ).toBe(false);
  });
});

describe('the capability key itself', () => {
  it('is a sibling of contacts / contactsAdd, not a child of either', async () => {
    const { expandCapabilities } = await import('@/lib/platform/capabilities');
    // Reading the directory must not imply changing it...
    expect(expandCapabilities(['company.contacts']).has('company.contactsEdit')).toBe(
      false
    );
    // ...nor must adding to it.
    expect(
      expandCapabilities(['company.contactsAdd']).has('company.contactsEdit')
    ).toBe(false);
    // ...and editing must not silently hand back either of the others.
    const edit = expandCapabilities(['company.contactsEdit']);
    expect(edit.has('company.contactsEdit')).toBe(true);
    expect(edit.has('company.contacts')).toBe(false);
    expect(edit.has('company.contactsAdd')).toBe(false);
  });

  it('is grantable in "requires approval" form', async () => {
    const { isApprovableCapability, APPROVAL_ACTION_BY_CAPABILITY } = await import(
      '@/lib/platform/capabilities'
    );
    expect(isApprovableCapability('company.contactsEdit')).toBe(true);
    expect(APPROVAL_ACTION_BY_CAPABILITY['company.contactsEdit']).toBe('contact.edit');
  });
});
