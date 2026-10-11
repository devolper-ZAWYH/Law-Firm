import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, roleInCompany } from '@/lib/platform/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canCreateFile, canEditFileCore } from '@/lib/platform/permissions';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Allowed international dialing codes for the CRM phone key. The UI offers these
 * as a dropdown; the server accepts any of them, OR any '+' followed by digits
 * (future-proofing), and falls back to Qatar '+974' when missing/invalid.
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

interface ContactRow {
  id: string;
  company_id: string;
  name: string | null;
  name_en: string | null;
  name_ar: string | null;
  phone: string | null;
  phone_country_code: string | null;
  email: string | null;
  notes: string | null;
  notes_en: string | null;
  notes_ar: string | null;
  created_by: string;
  created_at: string;
}

const SELECT_COLS =
  'id, name, name_en, name_ar, phone, phone_country_code, email, notes, notes_en, notes_ar, created_at';

function toContact(r: {
  id: string;
  name?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  phone?: string | null;
  phone_country_code?: string | null;
  email?: string | null;
  notes?: string | null;
  notes_en?: string | null;
  notes_ar?: string | null;
  created_at: string;
}) {
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

/**
 * GET /api/companies/[id]/contacts — list the company's contacts. Baseline
 * ADMIN ONLY — the CRM is admin-only, so managers/employees get 403 here (the
 * folder client name that managers see is resolved server-side in
 * lib/platform/files.ts and never hits this route) — EXTENDED to whoever can
 * create or edit a folder in this company (they need this list to populate
 * the create/edit-file client dropdown), and to anyone granted
 * 'company.contacts' ("See the client directory") or 'company.contactsEdit'.
 * Company isolation is
 * still enforced: even a global admin must target a real company.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const companyId = params.id;
  const role = roleInCompany(pu, companyId);
  if (role === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  if (
    !canAdmin(pu) &&
    // MANAGERS. They can add clients to the directory (see POST below) and the
    // CRM link is in their sidebar, so withholding the LIST handed them a page
    // that answered 403 — which is exactly what happened. Whoever may write to
    // the directory must be able to read it, or they cannot see what is
    // already in it and will enter the same client twice.
    role !== 'manager' &&
    !(await canCreateFile(pu, companyId)) &&
    !(await canEditFileCore(pu, companyId)) &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'company.contacts')) &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'company.contactsAdd')) &&
    // Same reasoning as the manager case above: whoever may CHANGE an entry
    // must be able to see the directory, or the grant buys them a page that
    // answers 403.
    !(await hasCapabilityGrant(pu.userId, companyId, 'company.contactsEdit'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('contacts')
      .select(SELECT_COLS)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data as ContactRow[] | null) ?? [];
    const contacts = rows.map(toContact);
    return NextResponse.json({ ok: true, contacts });
  } catch (err) {
    console.error('List contacts error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/companies/[id]/contacts — create a contact. Body: name_en /
 * name_ar (at least one required); phone, phone_country_code, email, notes_en,
 * notes_ar optional. The legacy NOT-NULL `name` column is always written =
 * (name_ar || name_en || ''); legacy `notes` similarly.
 *
 * WHO. Was admin-only; now also any MANAGER of the company, and any employee
 * granted 'company.contactsAdd'. Note that adding to the directory is a
 * SEPARATE grant from reading it ('company.contacts') — see capabilities.ts
 * for why the two are siblings rather than parent and child.
 *
 * Returns 202 (nothing created) when the caller holds the grant in "requires
 * approval" form, and 409 when it is gated with no approving manager assigned.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const companyId = params.id;
  // Even a global admin must target a real company; keep isolation explicit.
  const role = roleInCompany(pu, companyId);
  if (role === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const isPrivileged = canAdmin(pu) || role === 'manager';
  if (
    !isPrivileged &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'company.contactsAdd'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

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
  // Legacy columns keep older reads working; `name` is NOT NULL.
  const legacyName = nameAr || nameEn || '';
  const legacyNotes = notesAr || notesEn || '';

  try {
    const gate = await gateAction({
      userId: pu.userId,
      companyId,
      capabilityKey: 'company.contactsAdd',
      payload: {
        nameEn: nameEn || null,
        nameAr: nameAr || null,
        phone: phone || null,
        phoneCountryCode: phoneCode,
        email: email || null,
        notesEn: notesEn || null,
        notesAr: notesAr || null,
      },
      summaryEn: `Add ${nameEn || nameAr} to the client directory`,
      summaryAr: `إضافة ${nameAr || nameEn} إلى دليل العملاء`,
      isPrivileged,
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('contacts')
      .insert({
        company_id: companyId,
        name: legacyName,
        name_en: nameEn.length > 0 ? nameEn : null,
        name_ar: nameAr.length > 0 ? nameAr : null,
        phone: phone.length > 0 ? phone : null,
        phone_country_code: phoneCode,
        email: email.length > 0 ? email : null,
        notes: legacyNotes.length > 0 ? legacyNotes : null,
        notes_en: notesEn.length > 0 ? notesEn : null,
        notes_ar: notesAr.length > 0 ? notesAr : null,
        created_by: pu.userId,
      })
      .select(SELECT_COLS)
      .single();
    if (res.error) throw new Error(res.error.message);
    return NextResponse.json(
      { ok: true, contact: toContact(res.data as ContactRow) },
      { status: 201 }
    );
  } catch (err) {
    console.error('Create contact error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
