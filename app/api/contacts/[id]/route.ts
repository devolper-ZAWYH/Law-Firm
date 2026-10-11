import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, roleInCompany } from '@/lib/platform/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * Allowed international dialing codes for the CRM phone key (kept in sync with
 * the create route). Any listed code, or any '+' followed by digits, is
 * accepted; anything else falls back to Qatar '+974'.
 */
const ALLOWED_PHONE_CODES = [
  '+974', '+966', '+971', '+965', '+973', '+968',
  '+20', '+962', '+961', '+1', '+44',
];
const DEFAULT_PHONE_CODE = '+974';

function normalizePhoneCode(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return DEFAULT_PHONE_CODE;
  if (ALLOWED_PHONE_CODES.includes(s)) return s;
  if (/^\+\d{1,4}$/.test(s)) return s;
  return DEFAULT_PHONE_CODE;
}

const SELECT_COLS =
  'id, name, name_en, name_ar, phone, phone_country_code, email, notes, notes_en, notes_ar, created_at';

interface ContactRow {
  id: string;
  name: string | null;
  name_en: string | null;
  name_ar: string | null;
  phone: string | null;
  phone_country_code: string | null;
  email: string | null;
  notes: string | null;
  notes_en: string | null;
  notes_ar: string | null;
  created_at: string;
}

function toContact(r: ContactRow) {
  return {
    id: r.id,
    name: r.name ?? '',
    nameEn: r.name_en ?? '',
    nameAr: r.name_ar ?? '',
    phone: r.phone ?? '',
    phoneCountryCode: r.phone_country_code ?? DEFAULT_PHONE_CODE,
    email: r.email ?? '',
    notes: r.notes ?? '',
    notesEn: r.notes_en ?? '',
    notesAr: r.notes_ar ?? '',
    createdAt: r.created_at,
  };
}

/** Resolve the caller and require global admin. DELETE only — see requireEditor
 * for PATCH, which is open to managers and to a granted employee. */
async function requireAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; res: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  const pu = await getPlatformUser(session);
  if (!pu || !canAdmin(pu)) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 }),
    };
  }
  return { ok: true, userId: pu.userId };
}

/**
 * Resolve the caller for an EDIT of `contactId`.
 *
 * WHY THIS IS NOT requireAdmin. Editing used to be global-admin-only, and a
 * global admin needs no company check — which is why this route never had one.
 * Managers and granted employees have power in ONE company, so the contact's
 * own company_id has to be read first and the caller's role resolved against
 * it. Without that step a manager of company A could edit company B's clients
 * simply by knowing an id.
 *
 * Mirrors the POST route: admin or manager by role, anyone else by an explicit
 * 'company.contactsEdit' grant.
 */
async function requireEditor(
  contactId: string
): Promise<
  | { ok: true; userId: string; companyId: string; isPrivileged: boolean }
  | { ok: false; res: NextResponse }
> {
  const forbidden = {
    ok: false as const,
    res: NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 }),
  };

  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 }),
    };
  }

  const supabase = getSupabaseAdmin();
  const owner = await supabase
    .from('contacts')
    .select('company_id')
    .eq('id', contactId)
    .maybeSingle();
  if (owner.error) throw new Error(owner.error.message);
  const companyId = (owner.data as { company_id: string } | null)?.company_id;
  // A contact nobody may touch and a contact that does not exist are the same
  // answer to someone probing ids: say nothing either way.
  if (!companyId) return forbidden;

  const role = roleInCompany(pu, companyId);
  if (role === null && !canAdmin(pu)) return forbidden;

  const isPrivileged = canAdmin(pu) || role === 'manager';
  if (
    !isPrivileged &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'company.contactsEdit'))
  ) {
    return forbidden;
  }
  return { ok: true, userId: pu.userId, companyId, isPrivileged };
}

/**
 * PATCH /api/contacts/[id] — edit a contact.
 *
 * WHO. A global admin, any MANAGER of the contact's company, or an employee
 * granted 'company.contactsEdit'. Editing is a SEPARATE grant from reading
 * ('company.contacts') and from adding ('company.contactsAdd') — see
 * capabilities.ts for why all three are siblings rather than nested. DELETE
 * below is deliberately left admin-only.
 *
 * Body: name_en / name_ar (at least one required); phone, phone_country_code,
 * email, notes_en, notes_ar optional. The legacy NOT-NULL `name` column is
 * always written = (name_ar || name_en || ''); legacy `notes` similarly.
 *
 * Returns 202 (nothing changed) when the caller holds the grant in "requires
 * approval" form, and 409 when it is gated with no approving manager assigned.
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  let auth: Awaited<ReturnType<typeof requireEditor>>;
  try {
    auth = await requireEditor(params.id);
  } catch (err) {
    console.error('Update contact auth error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!auth.ok) return auth.res;

  let body: {
    name_en?: unknown;
    name_ar?: unknown;
    phone?: unknown;
    phone_country_code?: unknown;
    email?: unknown;
    notes_en?: unknown;
    notes_ar?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const nameEn = typeof body.name_en === 'string' ? body.name_en.trim() : '';
  const nameAr = typeof body.name_ar === 'string' ? body.name_ar.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phoneCode = normalizePhoneCode(body.phone_country_code);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const notesEn = typeof body.notes_en === 'string' ? body.notes_en.trim() : '';
  const notesAr = typeof body.notes_ar === 'string' ? body.notes_ar.trim() : '';
  if (!nameEn && !nameAr) {
    return NextResponse.json(
      { ok: false, error: 'Name is required.' },
      { status: 400 }
    );
  }
  const legacyName = nameAr || nameEn || '';
  const legacyNotes = notesAr || notesEn || '';

  try {
    const gate = await gateAction({
      userId: auth.userId,
      companyId: auth.companyId,
      capabilityKey: 'company.contactsEdit',
      payload: {
        contactId: params.id,
        nameEn: nameEn || null,
        nameAr: nameAr || null,
        phone: phone || null,
        phoneCountryCode: phoneCode,
        email: email || null,
        notesEn: notesEn || null,
        notesAr: notesAr || null,
      },
      summaryEn: `Edit ${nameEn || nameAr} in the client directory`,
      summaryAr: `تعديل ${nameAr || nameEn} في دليل العملاء`,
      isPrivileged: auth.isPrivileged,
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('contacts')
      .update({
        name: legacyName,
        name_en: nameEn.length > 0 ? nameEn : null,
        name_ar: nameAr.length > 0 ? nameAr : null,
        phone: phone.length > 0 ? phone : null,
        phone_country_code: phoneCode,
        email: email.length > 0 ? email : null,
        notes: legacyNotes.length > 0 ? legacyNotes : null,
        notes_en: notesEn.length > 0 ? notesEn : null,
        notes_ar: notesAr.length > 0 ? notesAr : null,
      })
      .eq('id', params.id)
      // Scoped by company as well as id: requireEditor authorized the caller
      // for THIS company, so the write must not be able to land anywhere else.
      .eq('company_id', auth.companyId)
      .select(SELECT_COLS)
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    const r = res.data as ContactRow | null;
    if (!r) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, contact: toContact(r) });
  } catch (err) {
    console.error('Update contact error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** DELETE /api/contacts/[id] — ADMIN ONLY. */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;

  try {
    const supabase = getSupabaseAdmin();
    const res = await supabase.from('contacts').delete().eq('id', params.id);
    if (res.error) throw new Error(res.error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete contact error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
