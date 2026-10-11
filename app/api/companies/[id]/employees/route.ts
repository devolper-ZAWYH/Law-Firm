import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  canAdmin,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import { canCreateFile, canEditFileCore } from '@/lib/platform/permissions';
import { hasAnyCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Per-company EMPLOYEES directory — ADMIN ONLY (view + add).
 *
 * A "member" here is a row of the company's memberships joined to app_users:
 * name, email, membership role (manager/employee) plus the global is_admin flag.
 * These are DIRECTORY entries — POST creates a membership (and, if needed, a
 * login-disabled app_users row); login credentials are set separately via User
 * Accounts.
 */

interface MembershipRow {
  user_id: string;
  role: 'manager' | 'employee';
  zkteco_employee_id: string | null;
}
interface UserRow {
  id: string;
  username: string;
  email: string | null;
  is_admin: boolean | null;
  full_name_en: string | null;
  full_name_ar: string | null;
  is_frozen: boolean | null;
}

interface MemberDTO {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string;
  role: 'manager' | 'employee';
  isAdmin: boolean;
  /** Migration #24 — a frozen account cannot sign in, and any live session for
   * it is revoked the moment it is frozen. */
  isFrozen: boolean;
  /** The person's Employee ID (matches attendance-sheet rows to them — see
   * lib/platform/attendance.ts). Purely a code-level identifier; dashboard
   * users are still identified by name everywhere else. */
  employeeId: string | null;
}

/**
 * GET /api/companies/[id]/employees — admin, a MANAGER of this company,
 * whoever can create/edit a folder here (they need this list to populate the
 * create/edit-file folder-leader dropdown), or an employee granted any
 * 'people.*' capability (they need this list to know who they may act on):
 * list its members.
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
  if (
    !canAdmin(pu) &&
    !isManagerOfCompany(pu, params.id) &&
    !(await canCreateFile(pu, params.id)) &&
    !(await canEditFileCore(pu, params.id)) &&
    !(await hasAnyCapabilityGrant(pu.userId, params.id, [
      'people.view',
      'people.schedule',
      'people.zkteco',
      'people.permissions',
    ]))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const companyId = params.id;

  try {
    const supabase = getSupabaseAdmin();
    const memRes = await supabase
      .from('memberships')
      .select('user_id, role, zkteco_employee_id')
      .eq('company_id', companyId);
    if (memRes.error) throw new Error(memRes.error.message);
    const memRows = (memRes.data as MembershipRow[] | null) ?? [];
    if (memRows.length === 0) {
      return NextResponse.json({ ok: true, members: [] });
    }

    const roleByUser = new Map<string, 'manager' | 'employee'>(
      memRows.map((m) => [m.user_id, m.role])
    );
    const employeeIdByUser = new Map<string, string | null>(
      memRows.map((m) => [m.user_id, m.zkteco_employee_id])
    );
    const userIds = Array.from(roleByUser.keys());

    const userRes = await supabase
      .from('app_users')
      .select('id, username, email, is_admin, full_name_en, full_name_ar, is_frozen')
      .in('id', userIds);
    if (userRes.error) throw new Error(userRes.error.message);
    const userRows = (userRes.data as UserRow[] | null) ?? [];

    const members: MemberDTO[] = userRows.map((u) => ({
      userId: u.id,
      nameEn: u.full_name_en,
      nameAr: u.full_name_ar,
      email: u.email ?? u.username,
      role: roleByUser.get(u.id) ?? 'employee',
      isAdmin: u.is_admin === true,
      isFrozen: u.is_frozen === true,
      employeeId: employeeIdByUser.get(u.id) ?? null,
    }));
    // Stable ordering: admins first, then managers, then employees, by name.
    members.sort((a, b) => {
      const rank = (m: MemberDTO) => (m.isAdmin ? 0 : m.role === 'manager' ? 1 : 2);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return (a.nameEn ?? a.email).localeCompare(b.nameEn ?? b.email);
    });

    return NextResponse.json({ ok: true, members });
  } catch (err) {
    console.error('List employees error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/companies/[id]/employees — ADMIN ONLY: add an employee by email.
 * If a user with that email exists → add an 'employee' membership (ignore if
 * already a member). Else → create a login-disabled app_users row (username =
 * email, placeholder password_hash that cannot log in, role 'user', optional
 * full names from `name`) + the employee membership. Returns the member.
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
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const companyId = params.id;

  let body: { email?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!email) {
    return NextResponse.json({ ok: false, error: 'Email is required.' }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'Invalid email address.' }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Confirm the company exists (foreign key would fail otherwise, but be clear).
    const compRes = await supabase
      .from('companies')
      .select('id')
      .eq('id', companyId)
      .maybeSingle();
    if (compRes.error) throw new Error(compRes.error.message);
    if (!compRes.data) {
      return NextResponse.json({ ok: false, error: 'Company not found.' }, { status: 404 });
    }

    // Find or create the target user (keyed by email).
    const existingRes = await supabase
      .from('app_users')
      .select('id, username, email, is_admin, full_name_en, full_name_ar')
      .eq('email', email)
      .maybeSingle();
    if (existingRes.error) throw new Error(existingRes.error.message);

    let user = existingRes.data as UserRow | null;
    if (!user) {
      // A placeholder hash that is NOT a valid bcrypt string, so verifyPassword
      // (bcrypt.compare) can never match — this account cannot log in until a
      // real credential is set via User Accounts.
      const insRes = await supabase
        .from('app_users')
        .insert({
          username: email,
          email,
          password_hash: '!disabled',
          role: 'user',
          full_name_en: name.length > 0 ? name : null,
          full_name_ar: name.length > 0 ? name : null,
        })
        .select('id, username, email, is_admin, full_name_en, full_name_ar')
        .single();
      if (insRes.error) {
        // 23505 = unique_violation: a race created the row; re-fetch it.
        if ((insRes.error as { code?: string }).code === '23505') {
          const reRes = await supabase
            .from('app_users')
            .select('id, username, email, is_admin, full_name_en, full_name_ar')
            .eq('email', email)
            .maybeSingle();
          if (reRes.error) throw new Error(reRes.error.message);
          user = reRes.data as UserRow | null;
        } else {
          throw new Error(insRes.error.message);
        }
      } else {
        user = insRes.data as UserRow;
      }
    }

    if (!user) {
      return NextResponse.json(
        { ok: false, error: 'Could not resolve the user.' },
        { status: 500 }
      );
    }

    // Add the employee membership (ignore if already a member of this company).
    const existingMem = await supabase
      .from('memberships')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existingMem.error) throw new Error(existingMem.error.message);

    let role: 'manager' | 'employee';
    if (existingMem.data) {
      // Already a member — leave the existing role untouched.
      role = (existingMem.data as { role: 'manager' | 'employee' }).role;
    } else {
      const memIns = await supabase
        .from('memberships')
        .insert({ user_id: user.id, company_id: companyId, role: 'employee' });
      // Tolerate a race that inserted the membership concurrently.
      if (memIns.error && (memIns.error as { code?: string }).code !== '23505') {
        throw new Error(memIns.error.message);
      }
      role = 'employee';
    }

    const member: MemberDTO = {
      userId: user.id,
      nameEn: user.full_name_en,
      nameAr: user.full_name_ar,
      email: user.email ?? user.username,
      role,
      isAdmin: user.is_admin === true,
      // A newly added person is never frozen. An existing account being
      // re-added to a company keeps whatever status it already had, which the
      // employees list reports on the next load.
      isFrozen: user.is_frozen === true,
      employeeId: null,
    };
    return NextResponse.json({ ok: true, member }, { status: 201 });
  } catch (err) {
    console.error('Add employee error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
