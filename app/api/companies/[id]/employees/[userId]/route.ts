import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import { getPlatformUser, canAdmin, isManagerOfCompany } from '@/lib/platform/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { setAccountFrozen } from '@/lib/users';
import { ACTIVE_TASK_STATUSES } from '@/lib/platform/tasks';
import {
  getMembershipPermissions,
  setMembershipPermissions,
  type MembershipPermissions,
} from '@/lib/platform/permissions';
import {
  getCapabilityGrantRows,
  setCapabilityGrants,
  hasAnyCapabilityGrant,
  hasCapabilityGrant,
} from '@/lib/platform/capabilityGrants';
import {
  isApprovableCapability,
  isCapabilityKey,
  type CapabilityKey,
} from '@/lib/platform/capabilities';
import {
  getWorkingHours,
  setWorkingHours,
  type WorkingHours,
} from '@/lib/platform/workingHours';
import { toPaylaterRole, type PaylaterRole } from '@/lib/platform/paylaterRoles';
import {
  listScheduleBlocks,
  replaceScheduleTerm,
  type ScheduleBlockInput,
} from '@/lib/platform/scheduleBlocks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Per-company EMPLOYEE row operations.
 *   GET    → admin, manager, or an employee granted any 'people.*' capability:
 *            the person's extra permissions (legacy flags + the full
 *            capability-tree grants) + working hours (for pre-filling the
 *            edit card).
 *   PATCH  → name / email / role / freeze are ADMIN ONLY (no capability
 *            covers these — see capabilities.ts's 'people' group hint).
 *            `workingHours`, `zktecoId` and `permissions`/`capabilityGrants`
 *            may ALSO be set by a MANAGER of this company, OR by an employee
 *            granted the matching capability ('people.schedule',
 *            'people.zkteco', 'people.permissions' respectively) — each
 *            field family is gated independently, so a grant of one does not
 *            imply the others. A manager/granted employee sending any
 *            name/email/role/isFrozen field is refused.
 *   DELETE → remove the person FROM THIS COMPANY only (membership + this
 *            company's file_access). Never deletes the account. 409 if they
 *            still hold active tasks here. ADMIN ONLY.
 */

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
  /** Migration #24 — a frozen account cannot sign in. */
  isFrozen: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEEKDAY_RE_OK = (days: unknown): days is number[] =>
  Array.isArray(days) &&
  days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** GET — admin or manager: this membership's extra permissions + working hours. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (
    !pu ||
    !(
      canAdmin(pu) ||
      isManagerOfCompany(pu, params.id) ||
      (await hasAnyCapabilityGrant(pu.userId, params.id, [
        'people.view',
        'people.schedule',
        'people.zkteco',
        'people.permissions',
      ]))
    )
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const supabase = getSupabaseAdmin();
    const [permissions, capabilityGrants, workingHours, memRes] = await Promise.all([
      getMembershipPermissions(params.userId, params.id),
      getCapabilityGrantRows(params.userId, params.id),
      getWorkingHours(params.userId, params.id),
      supabase
        .from('memberships')
        .select('zkteco_employee_id, paylater_role')
        .eq('user_id', params.userId)
        .eq('company_id', params.id)
        .maybeSingle(),
    ]);
    if (memRes.error) throw new Error(memRes.error.message);
    const memRow = memRes.data as {
      zkteco_employee_id: string | null;
      paylater_role?: string | null;
    } | null;
    const zktecoId = memRow?.zkteco_employee_id ?? null;
    // `paylater_role` may not exist yet (#35 unapplied) — absent reads as none.
    const paylaterRole = toPaylaterRole(memRow?.paylater_role);

    // Read SEPARATELY and tolerantly, rather than added to the select above.
    // That select throws on error, so naming a column #41 has not created yet
    // would take the whole card down — and this one is a display preference.
    // Absent reads as "not hidden", the behaviour before the flag existed.
    let hiddenFromWorkload = false;
    const hwRes = await supabase
      .from('memberships')
      .select('hidden_from_workload')
      .eq('user_id', params.userId)
      .eq('company_id', params.id)
      .maybeSingle();
    if (!hwRes.error) {
      hiddenFromWorkload =
        (hwRes.data as { hidden_from_workload?: boolean } | null)
          ?.hidden_from_workload === true;
    }
    return NextResponse.json({
      ok: true,
      permissions,
      capabilityGrants: capabilityGrants.map((g) => g.key),
      // The subset whose every use waits for the approving manager. Sent
      // alongside (not folded into) the grant list so the edit card can render
      // "granted" and "gated" as the two separate switches they are.
      approvalRequired: capabilityGrants
        .filter((g) => g.requiresApproval)
        .map((g) => g.key),
      workingHours,
      zktecoId,
      paylaterRole,
      hiddenFromWorkload,
      // The week as intervals (#42), every term. Best-effort like the flag
      // above: a portal running ahead of its migration shows none and keeps
      // the single start/end pair, which is what it had before.
      scheduleBlocks: await listScheduleBlocks(params.id, params.userId).catch(
        () => []
      ),
    });
  } catch (err) {
    console.error('Get employee permissions error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** PATCH — see file header: name/email/role admin-only; permissions/workingHours admin-or-manager. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const isAdmin = canAdmin(pu);
  const isManager = isManagerOfCompany(pu, params.id);
  if (
    !isAdmin &&
    !isManager &&
    !(await hasAnyCapabilityGrant(pu.userId, params.id, [
      'people.schedule',
      'people.zkteco',
      'people.permissions',
    ]))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const companyId = params.id;
  const userId = params.userId;

  let body: {
    nameEn?: unknown;
    nameAr?: unknown;
    email?: unknown;
    role?: unknown;
    permissions?: unknown;
    capabilityGrants?: unknown;
    approvalRequired?: unknown;
    workingHours?: unknown;
    zktecoId?: unknown;
    isFrozen?: unknown;
    paylaterRole?: unknown;
    hiddenFromWorkload?: unknown;
    scheduleTerm?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const hasEn = typeof body.nameEn === 'string';
  const hasAr = typeof body.nameAr === 'string';
  const hasEmail = typeof body.email === 'string';
  const hasRole = typeof body.role === 'string';
  const hasPermissions =
    typeof body.permissions === 'object' && body.permissions !== null;
  const hasCapabilityGrants = Array.isArray(body.capabilityGrants);
  const hasWorkingHours =
    typeof body.workingHours === 'object' && body.workingHours !== null;
  const hasZktecoId = body.zktecoId === null || typeof body.zktecoId === 'string';
  const hasIsFrozen = typeof body.isFrozen === 'boolean';
  // `null` clears the role; a string sets it. Anything else is not a request to
  // change it at all, so an unrecognised value cannot silently blank someone.
  const hasPaylaterRole =
    body.paylaterRole === null || typeof body.paylaterRole === 'string';
  // Whether this person appears on the Employee Tasks workload calendar (#41).
  // A display preference, not a permission — so it sits with the schedule and
  // the device id, which a manager may also set.
  const hasHiddenFromWorkload = typeof body.hiddenFromWorkload === 'boolean';

  /*
    THE WEEK AS INTERVALS (#42), sent as one whole term.

    Validated here rather than trusted from the form, because these decide
    attendance: a block whose mode is not one of the two, or whose end is not
    after its start, would either be rejected by the check constraint (a 500 the
    person cannot act on) or, worse, quietly change how somebody's lateness is
    measured.
  */
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const HHMM = /^\d{1,2}:\d{2}$/;
  let scheduleTerm:
    | { validFrom: string; validTo: string | null; blocks: ScheduleBlockInput[] }
    | null = null;
  if (body.scheduleTerm !== undefined && body.scheduleTerm !== null) {
    const term = body.scheduleTerm as {
      validFrom?: unknown;
      validTo?: unknown;
      blocks?: unknown;
    };
    const validFrom = typeof term.validFrom === 'string' ? term.validFrom.trim() : '';
    const validToRaw = typeof term.validTo === 'string' ? term.validTo.trim() : '';
    if (!ISO_DATE.test(validFrom)) {
      return NextResponse.json(
        { ok: false, error: 'The schedule needs a start date.' },
        { status: 400 }
      );
    }
    if (validToRaw && !ISO_DATE.test(validToRaw)) {
      return NextResponse.json(
        { ok: false, error: 'That end date is not a date.' },
        { status: 400 }
      );
    }
    if (validToRaw && validToRaw < validFrom) {
      return NextResponse.json(
        { ok: false, error: 'The schedule ends before it starts.' },
        { status: 400 }
      );
    }
    const rawBlocks = Array.isArray(term.blocks) ? term.blocks : [];
    const blocks: ScheduleBlockInput[] = [];
    for (const raw of rawBlocks) {
      const b = raw as {
        weekday?: unknown;
        startTime?: unknown;
        endTime?: unknown;
        mode?: unknown;
      };
      const weekday = typeof b.weekday === 'number' ? b.weekday : Number(b.weekday);
      const startTime = typeof b.startTime === 'string' ? b.startTime.trim() : '';
      const endTime = typeof b.endTime === 'string' ? b.endTime.trim() : '';
      const mode = b.mode === 'online' ? 'online' : b.mode === 'office' ? 'office' : null;
      if (
        !Number.isInteger(weekday) ||
        weekday < 0 ||
        weekday > 6 ||
        !HHMM.test(startTime) ||
        !HHMM.test(endTime) ||
        mode === null
      ) {
        return NextResponse.json(
          { ok: false, error: 'One of the schedule rows is incomplete.' },
          { status: 400 }
        );
      }
      if (endTime <= startTime) {
        // Lexicographic works on zero-padded HH:MM, and says the real thing:
        // an interval that ends before it starts is a typo, not a schedule.
        return NextResponse.json(
          { ok: false, error: 'A schedule row ends before it starts.' },
          { status: 400 }
        );
      }
      blocks.push({ weekday, startTime, endTime, mode });
    }
    scheduleTerm = { validFrom, validTo: validToRaw || null, blocks };
  }

  // A manager (or a capability-granted employee) may ONLY touch
  // permissions/workingHours/zktecoId — never identity/role/freeze, which stay
  // ADMIN ONLY (no capability grants that).
  if (!isAdmin && (hasEn || hasAr || hasEmail || hasRole || hasIsFrozen)) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // Each remaining field family is gated on its OWN capability — being
  // granted one (e.g. 'people.schedule') does not imply the others.
  if (
    (hasWorkingHours || scheduleTerm !== null) &&
    !isAdmin &&
    !isManager &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'people.schedule'))
  ) {
    // The block schedule IS the working hours, in a richer form, so it is the
    // same grant. Whoever may say which days somebody works may say which
    // hours of them are in the office.
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  if (
    hasZktecoId &&
    !isAdmin &&
    !isManager &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'people.zkteco'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  if (
    (hasPermissions || hasCapabilityGrants) &&
    !isAdmin &&
    !isManager &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'people.permissions'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  // The PayLater role decides who may act on debt-recovery files, so it is
  // gated as a permission grant, on the same key as the rest of them — not as
  // an identity field, which would have made it admin-only and left managers
  // unable to staff their own team.
  if (
    hasPaylaterRole &&
    !isAdmin &&
    !isManager &&
    !(await hasCapabilityGrant(pu.userId, companyId, 'people.permissions'))
  ) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // PRIVILEGE-ESCALATION GUARD: a non-admin may not grant permissions (or
  // capability-tree grants — same risk) to THEMSELVES.
  //
  // The membership_permissions flags extend a member up to actions whose baseline
  // is ADMIN ONLY — canCreateFile / canEditFile / canDeleteFile (see the table in
  // lib/platform/permissions.ts, and canDeleteFile there, which consults the flag
  // with no role qualifier). Without this check a manager could PATCH their own
  // userId, self-grant canDeleteFile, and then permanently delete any folder in
  // the company — cascading to its tasks, task history, access grants and access
  // requests — which the two-layer model reserves to a global admin. The same
  // reasoning applies to capabilityGrants, since setCapabilityGrants() re-syncs
  // those same legacy booleans (see capabilityGrants.ts).
  //
  // Granting to OTHER members is the intended manager workflow and is unchanged;
  // only self-targeting is refused. An admin self-granting stays allowed because
  // it is a no-op: every capability check short-circuits on pu.isAdmin first.
  if (
    !isAdmin &&
    (hasPermissions || hasCapabilityGrants || hasPaylaterRole) &&
    userId === pu.userId
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'You cannot change your own permissions / لا يمكنك تغيير صلاحياتك الخاصة',
      },
      { status: 403 }
    );
  }

  // Freezing your own account would sign you out mid-request and leave nobody
  // able to undo it if you are the only admin.
  if (hasIsFrozen && body.isFrozen === true && userId === pu.userId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'You cannot freeze your own account / لا يمكنك تجميد حسابك الخاص',
      },
      { status: 400 }
    );
  }

  if (
    !hasEn &&
    !hasAr &&
    !hasEmail &&
    !hasRole &&
    !hasPermissions &&
    !hasCapabilityGrants &&
    !hasWorkingHours &&
    !hasZktecoId &&
    !hasIsFrozen &&
    !hasPaylaterRole
  ) {
    return NextResponse.json({ ok: false, error: 'No changes provided.' }, { status: 400 });
  }
  const zktecoId = hasZktecoId
    ? body.zktecoId === null
      ? null
      : (body.zktecoId as string).trim() || null
    : undefined;
  const nameEn = hasEn ? (body.nameEn as string).trim() : null;
  const nameAr = hasAr ? (body.nameAr as string).trim() : null;

  let newEmail: string | null = null;
  if (hasEmail) {
    const e = (body.email as string).trim().toLowerCase();
    if (e.length === 0 || !EMAIL_RE.test(e)) {
      return NextResponse.json(
        { ok: false, error: 'Enter a valid email / أدخل بريدًا صحيحًا' },
        { status: 400 }
      );
    }
    newEmail = e;
  }

  let newRole: 'manager' | 'employee' | null = null;
  if (hasRole) {
    const r = body.role as string;
    if (r !== 'manager' && r !== 'employee') {
      return NextResponse.json({ ok: false, error: 'Invalid role.' }, { status: 400 });
    }
    newRole = r;
  }

  let permissionsPatch: Partial<MembershipPermissions> | null = null;
  if (hasPermissions) {
    const p = body.permissions as Record<string, unknown>;
    const flags: (keyof MembershipPermissions)[] = [
      'canCreateFile',
      'canEditFile',
      'canDeleteFile',
      'canMoveFileSection',
      'canCreateTask',
      'canManageFileAccess',
      'canUploadAttendance',
    ];
    permissionsPatch = {};
    for (const flag of flags) {
      if (typeof p[flag] === 'boolean') permissionsPatch[flag] = p[flag] as boolean;
    }
  }

  // Validated against the shared list, so the dropdown and the database check
  // constraint can never disagree. `undefined` = not sent; `null` = clear it.
  let paylaterRolePatch: PaylaterRole | null | undefined = undefined;
  if (hasPaylaterRole) {
    if (body.paylaterRole === null || body.paylaterRole === '') {
      paylaterRolePatch = null;
    } else {
      const parsed = toPaylaterRole(body.paylaterRole);
      if (!parsed) {
        return NextResponse.json(
          { ok: false, error: 'Unknown PayLater role.' },
          { status: 400 }
        );
      }
      paylaterRolePatch = parsed;
    }
  }

  let capabilityGrantsPatch: CapabilityKey[] | null = null;
  if (hasCapabilityGrants) {
    const raw = body.capabilityGrants as unknown[];
    if (!raw.every((k) => typeof k === 'string' && isCapabilityKey(k))) {
      return NextResponse.json(
        { ok: false, error: 'Invalid capability key.' },
        { status: 400 }
      );
    }
    capabilityGrantsPatch = raw as CapabilityKey[];
  }

  // WHICH GRANTS ARE GATED. Only meaningful together with capabilityGrants —
  // the flag lives ON a grant row, so it is written by the same replace-the-
  // whole-set operation and cannot be sent on its own.
  let approvalRequiredPatch: CapabilityKey[] = [];
  if (hasCapabilityGrants && Array.isArray(body.approvalRequired)) {
    const raw = body.approvalRequired as unknown[];
    if (!raw.every((k) => typeof k === 'string' && isCapabilityKey(k))) {
      return NextResponse.json(
        { ok: false, error: 'Invalid capability key.' },
        { status: 400 }
      );
    }
    const keys = raw as CapabilityKey[];
    // Reject rather than silently drop: a client asking to gate something that
    // cannot be gated has misunderstood, and answering 200 would tell them the
    // gate is on when nothing would ever hold.
    const ungateable = keys.filter((k) => !isApprovableCapability(k));
    if (ungateable.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `These permissions cannot require approval: ${ungateable.join(', ')}.`,
        },
        { status: 400 }
      );
    }
    // A flag on a key that is not being granted is meaningless — drop it, so
    // unchecking a permission cannot leave a dangling gate behind.
    const grantedSet = new Set(capabilityGrantsPatch ?? []);
    approvalRequiredPatch = keys.filter((k) => grantedSet.has(k));
  }

  let workingHoursPatch: Partial<WorkingHours> | null = null;
  if (hasWorkingHours) {
    const w = body.workingHours as Record<string, unknown>;
    workingHoursPatch = {};
    if (w.workingDays === null) {
      workingHoursPatch.workingDays = null;
    } else if (WEEKDAY_RE_OK(w.workingDays)) {
      workingHoursPatch.workingDays = w.workingDays;
    } else if (w.workingDays !== undefined) {
      return NextResponse.json(
        { ok: false, error: 'Invalid working days.' },
        { status: 400 }
      );
    }
    for (const key of ['startTime', 'endTime'] as const) {
      const v = w[key];
      if (v === null) {
        workingHoursPatch[key] = null;
      } else if (typeof v === 'string' && TIME_RE.test(v)) {
        workingHoursPatch[key] = v;
      } else if (v !== undefined) {
        return NextResponse.json(
          { ok: false, error: 'Invalid time — use HH:MM.' },
          { status: 400 }
        );
      }
    }
  }

  try {
    const supabase = getSupabaseAdmin();

    const memRes = await supabase
      .from('memberships')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (memRes.error) throw new Error(memRes.error.message);
    if (!memRes.data) {
      return NextResponse.json(
        { ok: false, error: 'This person is not a member of this company.' },
        { status: 404 }
      );
    }
    let role = (memRes.data as { role: 'manager' | 'employee' }).role;

    if (zktecoId) {
      const dupeZk = await supabase
        .from('memberships')
        .select('user_id')
        .eq('company_id', companyId)
        .eq('zkteco_employee_id', zktecoId)
        .neq('user_id', userId)
        .maybeSingle();
      if (dupeZk.error) throw new Error(dupeZk.error.message);
      if (dupeZk.data) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'That ZKTeco ID is already assigned to someone else in this company.',
          },
          { status: 409 }
        );
      }
    }

    if (newEmail) {
      const dupe = await supabase
        .from('app_users')
        .select('id')
        .eq('email', newEmail)
        .neq('id', userId)
        .maybeSingle();
      if (dupe.error) throw new Error(dupe.error.message);
      if (dupe.data) {
        return NextResponse.json(
          { ok: false, error: 'Email already in use / البريد مستخدم بالفعل' },
          { status: 409 }
        );
      }
    }

    const patch: {
      full_name_en?: string | null;
      full_name_ar?: string | null;
      email?: string;
      username?: string;
    } = {};
    if (hasEn) patch.full_name_en = nameEn && nameEn.length > 0 ? nameEn : null;
    if (hasAr) patch.full_name_ar = nameAr && nameAr.length > 0 ? nameAr : null;
    if (newEmail) {
      patch.email = newEmail;
      patch.username = newEmail;
    }

    let user: UserRow;
    if (Object.keys(patch).length > 0) {
      const updRes = await supabase
        .from('app_users')
        .update(patch)
        .eq('id', userId)
        .select('id, username, email, is_admin, full_name_en, full_name_ar, is_frozen')
        .single();
      if (updRes.error) throw new Error(updRes.error.message);
      user = updRes.data as UserRow;
    } else {
      const selRes = await supabase
        .from('app_users')
        .select('id, username, email, is_admin, full_name_en, full_name_ar, is_frozen')
        .eq('id', userId)
        .single();
      if (selRes.error) throw new Error(selRes.error.message);
      user = selRes.data as UserRow;
    }

    if (newRole && newRole !== role) {
      const roleUpd = await supabase
        .from('memberships')
        .update({ role: newRole })
        .eq('company_id', companyId)
        .eq('user_id', userId);
      if (roleUpd.error) throw new Error(roleUpd.error.message);
      role = newRole;
    }

    // GATE — the three people permissions, each on its own key. A caller may
    // hold one gated and another outright, so they are asked separately, and a
    // request mixing a HELD change with others is refused rather than
    // half-applied (the parked action replays only its own field).
    const isPrivilegedHere = isAdmin || isManagerOfCompany(pu, companyId);
    const targetLabel = user.full_name_en || user.username;
    const sentCount =
      (workingHoursPatch ? 1 : 0) +
      (zktecoId !== undefined ? 1 : 0) +
      (capabilityGrantsPatch ? 1 : 0);
    const mixedRefusal = () =>
      NextResponse.json(
        {
          ok: false,
          code: 'change_needs_own_request',
          error:
            'That change needs approval, so it has to be saved on its own. Save the other changes first.',
        },
        { status: 409 }
      );

    if (workingHoursPatch) {
      const g = await gateAction({
        userId: pu.userId,
        companyId,
        capabilityKey: 'people.schedule',
        payload: { userId, ...workingHoursPatch },
        summaryEn: `Set working days and hours for ${targetLabel}`,
        summaryAr: `تحديد أيام وساعات عمل ${targetLabel}`,
        isPrivileged: isPrivilegedHere,
      });
      if (g.kind === 'no_approver') return noApproverResponse();
      if (g.kind === 'held') {
        if (sentCount > 1) return mixedRefusal();
        return heldResponse(g.request.id);
      }
    }
    if (zktecoId !== undefined) {
      const g = await gateAction({
        userId: pu.userId,
        companyId,
        capabilityKey: 'people.zkteco',
        payload: { userId, zktecoId },
        summaryEn: `Set the attendance-device ID for ${targetLabel}`,
        summaryAr: `تحديد رقم جهاز الحضور لـ ${targetLabel}`,
        isPrivileged: isPrivilegedHere,
      });
      if (g.kind === 'no_approver') return noApproverResponse();
      if (g.kind === 'held') {
        if (sentCount > 1) return mixedRefusal();
        return heldResponse(g.request.id);
      }
    }
    if (capabilityGrantsPatch) {
      const g = await gateAction({
        userId: pu.userId,
        companyId,
        capabilityKey: 'people.permissions',
        payload: {
          userId,
          capabilityGrants: capabilityGrantsPatch,
          approvalRequired: approvalRequiredPatch,
        },
        summaryEn: `Change the permissions of ${targetLabel}`,
        summaryAr: `تغيير صلاحيات ${targetLabel}`,
        isPrivileged: isPrivilegedHere,
      });
      if (g.kind === 'no_approver') return noApproverResponse();
      if (g.kind === 'held') {
        if (sentCount > 1) return mixedRefusal();
        return heldResponse(g.request.id);
      }
    }

    if (zktecoId !== undefined) {
      const zkUpd = await supabase
        .from('memberships')
        .update({ zkteco_employee_id: zktecoId })
        .eq('company_id', companyId)
        .eq('user_id', userId);
      if (zkUpd.error) throw new Error(zkUpd.error.message);
    }

    // ONE COLUMN, so setting a role REPLACES whatever was there. There is no
    // "clear the others" step to forget, which is the whole reason this is a
    // column and not four capability rows.
    if (paylaterRolePatch !== undefined) {
      const plUpd = await supabase
        .from('memberships')
        .update({ paylater_role: paylaterRolePatch })
        .eq('company_id', companyId)
        .eq('user_id', userId);
      if (plUpd.error) throw new Error(plUpd.error.message);
    }

    // The week as intervals. Same permission as the schedule it replaces —
    // whoever sets somebody's working days sets the shape of their week.
    if (scheduleTerm) {
      const stored = await replaceScheduleTerm({
        companyId,
        userId,
        validFrom: scheduleTerm.validFrom,
        validTo: scheduleTerm.validTo,
        blocks: scheduleTerm.blocks,
        createdBy: pu.userId,
      });
      if (!stored) {
        return NextResponse.json(
          {
            ok: true,
            warning: 'not_migrated',
            error:
              'Everything else was saved, but the work schedule could not be — that setting needs a database migration that has not run yet.',
          },
          { status: 200 }
        );
      }
    }

    // Hide/show on the workload calendar. DEPLOY SAFETY: #41 may not have run
    // yet, and a display preference is not worth failing the whole save for —
    // the rest of the card is stored and the row keeps appearing, which is the
    // behaviour before the flag existed.
    if (hasHiddenFromWorkload) {
      const hwUpd = await supabase
        .from('memberships')
        .update({ hidden_from_workload: body.hiddenFromWorkload as boolean })
        .eq('company_id', companyId)
        .eq('user_id', userId);
      if (hwUpd.error) {
        const code = (hwUpd.error as { code?: string }).code;
        if (code !== '42703' && code !== '42P01') {
          throw new Error(hwUpd.error.message);
        }
      }
    }

    // Freeze / unfreeze. Freezing also revokes every live session for this
    // person (see setAccountFrozen), so they are signed out immediately rather
    // than lingering until their JWT expires.
    if (hasIsFrozen) {
      const okFrozen = await setAccountFrozen(userId, body.isFrozen as boolean);
      if (!okFrozen) {
        return NextResponse.json(
          { ok: false, error: 'Could not update account status.' },
          { status: 500 }
        );
      }
      user.is_frozen = body.isFrozen as boolean;
    }

    if (permissionsPatch) {
      await setMembershipPermissions(userId, companyId, permissionsPatch);
    }
    // Capability-tree grants are applied AFTER the legacy patch above (if both
    // were sent) since setCapabilityGrants() re-syncs those same legacy
    // booleans from the expanded grant set — it must have the last word.
    if (capabilityGrantsPatch) {
      await setCapabilityGrants(
        userId,
        companyId,
        capabilityGrantsPatch,
        pu.userId,
        approvalRequiredPatch
      );
    }
    if (workingHoursPatch) {
      await setWorkingHours(userId, companyId, workingHoursPatch);
    }
    const [permissions, capabilityGrants, workingHours, freshMemRes] = await Promise.all([
      getMembershipPermissions(userId, companyId),
      getCapabilityGrantRows(userId, companyId),
      getWorkingHours(userId, companyId),
      supabase
        .from('memberships')
        .select('zkteco_employee_id, paylater_role')
        .eq('user_id', userId)
        .eq('company_id', companyId)
        .maybeSingle(),
    ]);
    if (freshMemRes.error) throw new Error(freshMemRes.error.message);
    const freshMem = freshMemRes.data as {
      zkteco_employee_id: string | null;
      paylater_role?: string | null;
    } | null;
    const currentZktecoId = freshMem?.zkteco_employee_id ?? null;
    const currentPaylaterRole = toPaylaterRole(freshMem?.paylater_role);

    const member: MemberDTO = {
      userId: user.id,
      nameEn: user.full_name_en,
      nameAr: user.full_name_ar,
      email: user.email ?? user.username,
      role,
      isAdmin: user.is_admin === true,
      isFrozen: user.is_frozen === true,
    };
    return NextResponse.json({
      ok: true,
      member,
      permissions,
      capabilityGrants: capabilityGrants.map((g) => g.key),
      approvalRequired: capabilityGrants
        .filter((g) => g.requiresApproval)
        .map((g) => g.key),
      workingHours,
      zktecoId: currentZktecoId,
      paylaterRole: currentPaylaterRole,
    });
  } catch (err) {
    console.error('Edit employee error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/** DELETE — ADMIN ONLY: remove from this company (membership + file_access). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; userId: string } }
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
  const userId = params.userId;

  try {
    const supabase = getSupabaseAdmin();

    const memRes = await supabase
      .from('memberships')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (memRes.error) throw new Error(memRes.error.message);
    if (!memRes.data) {
      return NextResponse.json(
        { ok: false, error: 'This person is not a member of this company.' },
        { status: 404 }
      );
    }

    const filesRes = await supabase
      .from('files')
      .select('id')
      .eq('company_id', companyId);
    if (filesRes.error) throw new Error(filesRes.error.message);
    const fileIds = ((filesRes.data as { id: string }[] | null) ?? []).map((f) => f.id);

    if (fileIds.length > 0) {
      // Two counted queries rather than an `.or()` filter STRING. The `.or()`
      // argument is raw PostgREST filter syntax, so interpolating `userId` (a
      // URL path segment) into it let a crafted value rewrite this guard —
      // the one check standing between "delete this membership" and orphaning
      // the tasks that person still owns. Values passed to .eq()/.in() are
      // encoded as parameters by supabase-js and cannot escape their slot.
      // Same reasoning as findUserByIdentifier in lib/users.ts.
      const activeAs = async (column: 'assignee_id' | 'approver_id') => {
        const res = await supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .in('file_id', fileIds)
          .in('status', ACTIVE_TASK_STATUSES)
          .eq(column, userId);
        if (res.error) throw new Error(res.error.message);
        return res.count ?? 0;
      };
      const [asAssignee, asApprover] = await Promise.all([
        activeAs('assignee_id'),
        activeAs('approver_id'),
      ]);
      if (asAssignee + asApprover > 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Reassign or close this person’s open tasks first / أعد إسناد أو أغلق مهام هذا الشخص المفتوحة أولاً',
          },
          { status: 409 }
        );
      }

      const faDel = await supabase
        .from('file_access')
        .delete()
        .eq('user_id', userId)
        .in('file_id', fileIds);
      if (faDel.error) throw new Error(faDel.error.message);
    }

    const memDel = await supabase
      .from('memberships')
      .delete()
      .eq('company_id', companyId)
      .eq('user_id', userId);
    if (memDel.error) throw new Error(memDel.error.message);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete employee error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
