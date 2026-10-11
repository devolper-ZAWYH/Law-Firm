import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, roleInCompany } from '@/lib/platform/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchUsersByIds, listCompanyManagers } from '@/lib/platform/access';
import { isMissingRelationError } from '@/lib/platform/schemaCompat';
import { getApprovalManagerId } from '@/lib/platform/approvals';

/**
 * Every settings column EXCEPT approval_manager_id, which arrives in migration
 * #31. Selecting a column the database does not have yet fails the WHOLE query,
 * so the read below asks for it and falls back to this list — otherwise this
 * endpoint 500s for the entire window between deploying and migrating, and it
 * is on the path every signed-in page takes.
 */
const SETTINGS_COLS_BASE =
  'working_days, days_per_color_step, telegram_bot_token, telegram_chat_id, alerts_enabled, telegram_enabled, attendance_objection_approver_id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SettingsRow {
  working_days: number[] | null;
  days_per_color_step: number | null;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  alerts_enabled: boolean | null;
  telegram_enabled: boolean | null;
  attendance_objection_approver_id: string | null;
  approval_manager_id: string | null;
}

/**
 * GET — any MEMBER of the company (admin: any company) may view its settings.
 *
 * SECRET FIELDS ARE ADMIN-ONLY. `telegram_bot_token` / `telegram_chat_id` are
 * live credentials: the token alone grants full control of the firm's bot (read
 * the whole alert-channel history, post as the firm). Only a global admin can
 * EDIT them (see PUT below), so only a global admin receives their values here —
 * every other member gets '' in their place.
 *
 * They are blanked rather than omitted so the response shape stays exactly the
 * same for every caller: components/SettingsView.tsx types both as `string` and
 * binds them to controlled inputs, and components/InstructionsGuide.tsx reads
 * days_per_color_step from this same endpoint as a plain employee. Dropping the
 * keys would turn those inputs uncontrolled; blanking changes nothing visible,
 * because the fields are already `disabled` for non-admins there.
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
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const supabase = getSupabaseAdmin();
    let res = await supabase
      .from('companies')
      .select(`${SETTINGS_COLS_BASE}, approval_manager_id`)
      .eq('id', companyId)
      .maybeSingle();
    if (res.error && isMissingRelationError(res.error)) {
      // Pre-migration-#31: re-read without the column. The approver then reads
      // as unassigned, which is exactly what it is.
      res = await supabase
        .from('companies')
        .select(SETTINGS_COLS_BASE)
        .eq('id', companyId)
        .maybeSingle();
    }
    if (res.error) throw new Error(res.error.message);
    const row = res.data as SettingsRow | null;
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    // Only the role that may CHANGE the Telegram credentials may READ them.
    const seesSecrets = canAdmin(pu);

    const managers = await listCompanyManagers(companyId).catch((err) => {
      console.error('Settings: could not list managers:', err);
      return [];
    });
    // Resolve the assigned approver only when the manager list does not
    // already carry them — the normal case costs no extra query.
    const assignedApprovalManager = row.approval_manager_id ?? null;
    let missingApprovalManager: {
      userId: string;
      username: string;
      fullNameEn: string | null;
      fullNameAr: string | null;
    } | null = null;
    if (
      assignedApprovalManager &&
      !managers.some((m) => m.userId === assignedApprovalManager)
    ) {
      const found = await fetchUsersByIds([assignedApprovalManager]).catch(() => null);
      missingApprovalManager = found?.get(assignedApprovalManager) ?? {
        // Deleted outright: still say SOMETHING is assigned rather than let the
        // form imply nothing is.
        userId: assignedApprovalManager,
        username: assignedApprovalManager,
        fullNameEn: null,
        fullNameAr: null,
      };
    }
    return NextResponse.json({
      ok: true,
      settings: {
        working_days: Array.isArray(row.working_days) ? row.working_days : [0, 1, 2, 3, 4],
        days_per_color_step:
          typeof row.days_per_color_step === 'number' ? row.days_per_color_step : 3,
        telegram_bot_token: seesSecrets ? row.telegram_bot_token ?? '' : '',
        telegram_chat_id: seesSecrets ? row.telegram_chat_id ?? '' : '',
        // Phase 7 toggles. Default alerts ON, Telegram OFF (matches the schema
        // defaults) if the columns are null / not yet migrated. These are not
        // secrets — a manager needs to see whether alerts/Telegram are on.
        alerts_enabled: row.alerts_enabled !== false,
        telegram_enabled: row.telegram_enabled === true,
        // The ONE manager who receives and decides attendance objections
        // raised from the upload review table. Null = objections are off for
        // this company. Not a secret: the uploader needs to know who decides.
        attendance_objection_approver_id: row.attendance_objection_approver_id ?? null,
        // The ONE manager who decides capability-approval requests. A separate
        // role from the objection approver above — the same person may hold
        // both, but they answer different questions and are assigned
        // independently. Also not a secret: an employee whose permission is
        // gated benefits from knowing whose desk their request lands on. Only
        // an admin may CHANGE either (see PUT).
        approval_manager_id: row.approval_manager_id ?? '',
      },
      // The eligible choices for BOTH approver dropdowns, so Settings renders
      // without a second round trip. PUT re-validates whatever comes back, so
      // this list is a convenience, not the authority — and a failure here must
      // not take the whole settings page down with it.
      managers,
      // THE HOLDER, when they are no longer among those choices. An assignment
      // outlives the assigned person's manager role on purpose (nothing may
      // rewrite it but an admin), which means the dropdown can be asked to
      // display somebody who is not in its own list. Left to itself the
      // <select> silently shows its first entry instead — "— Nobody —" — and
      // the admin reads an empty box as "nothing is assigned". Naming the
      // holder here lets the form show the truth and say what is wrong with it.
      approval_manager_missing: missingApprovalManager,
    });
  } catch (err) {
    console.error('Get settings error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

// PUT — ADMIN ONLY (global is_admin). Managers view but cannot change.
export async function PUT(
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

  let body: {
    working_days?: unknown;
    days_per_color_step?: unknown;
    telegram_bot_token?: unknown;
    telegram_chat_id?: unknown;
    alerts_enabled?: unknown;
    telegram_enabled?: unknown;
    attendance_objection_approver_id?: unknown;
    approval_manager_id?: unknown;
    approval_manager_clear?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const rawDays: unknown[] = Array.isArray(body.working_days) ? body.working_days : [];
  const workingDays = Array.from(
    new Set(
      rawDays.filter(
        (d): d is number =>
          typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6
      )
    )
  ).sort((a, b) => a - b);
  if (workingDays.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Select at least one working day.' },
      { status: 400 }
    );
  }

  const dpcsNum =
    typeof body.days_per_color_step === 'number'
      ? body.days_per_color_step
      : Number(body.days_per_color_step);
  const daysPerStep = Number.isFinite(dpcsNum) ? Math.floor(dpcsNum) : 0;
  if (!Number.isInteger(daysPerStep) || daysPerStep < 1) {
    return NextResponse.json(
      { ok: false, error: 'Days per color step must be at least 1.' },
      { status: 400 }
    );
  }

  const tgToken =
    typeof body.telegram_bot_token === 'string' ? body.telegram_bot_token.trim() : '';
  const tgChat =
    typeof body.telegram_chat_id === 'string' ? body.telegram_chat_id.trim() : '';

  // Phase 7 optional toggles. Coerce to booleans (default alerts ON, Telegram
  // OFF if absent/invalid). Everything the platform notifies is off-able here.
  const alertsEnabled =
    typeof body.alerts_enabled === 'boolean' ? body.alerts_enabled : true;
  const telegramEnabled =
    typeof body.telegram_enabled === 'boolean' ? body.telegram_enabled : false;

  // TWO ADMIN-ASSIGNED APPROVERS, resolved against the same manager list.
  // They answer different questions — one decides attendance objections, the
  // other decides held capability actions — and the same person may hold both,
  // but each is assigned on its own.
  //
  // Both must be an actual MANAGER of THIS company: an arbitrary user id must
  // not become able to decide other people's attendance, nor to read and wave
  // through another company's permission requests. This PUT is already
  // admin-only, which is the guarantee that matters for the capability
  // approver: whoever hands out a gated permission cannot appoint themselves
  // (or a friend) as the one who polices it.
  const companyManagers = await listCompanyManagers(companyId);
  const isCompanyManager = (id: string) =>
    companyManagers.some((m) => m.userId === id);

  // Objections: absent/empty clears the setting (objections can then no longer
  // be raised).
  const rawApprover =
    typeof body.attendance_objection_approver_id === 'string'
      ? body.attendance_objection_approver_id.trim()
      : '';
  let approverId: string | null = null;
  if (rawApprover) {
    if (!isCompanyManager(rawApprover)) {
      return NextResponse.json(
        { ok: false, error: 'That person is not a manager of this company.' },
        { status: 400 }
      );
    }
    approverId = rawApprover;
  }

  // CAPABILITY APPROVALS — the one assignment that must never move on its own.
  //
  // An empty value used to mean "clear it", which turned out to be the way the
  // assignment quietly lost itself. Settings renders the holder as one <option>
  // among the company's managers; once the assigned person stops being a
  // manager that option is gone, the <select> falls back to its first entry
  // ("— Nobody —"), and the form now reports an empty value that the admin
  // never chose. Honouring it cleared the assignment — or, when the stale id
  // was echoed back instead, failed the membership check below and took every
  // other setting on the page down with it (400 on an unrelated save).
  //
  // So an empty value now means NOTHING CHANGED, and clearing takes a separate,
  // unambiguous flag that only a real "— Nobody —" choice sets. The three
  // intents are distinct:
  //
  //   approval_manager_clear: true   → unassign (an explicit admin decision)
  //   approval_manager_id: <someone> → assign them (must be a manager today)
  //   anything else                  → leave the assignment untouched
  const storedApprovalManager = await getApprovalManagerId(companyId).catch(
    // Pre-migration-#31 the column does not exist. Treat it as unassigned;
    // the write below is retried without the column anyway.
    () => null
  );
  const rawApprovalManager = body.approval_manager_id;
  const wantedApprovalManager =
    typeof rawApprovalManager === 'string' ? rawApprovalManager.trim() : '';
  let approvalManagerPatch: { approval_manager_id: string | null } | null = null;

  if (body.approval_manager_clear === true) {
    approvalManagerPatch = { approval_manager_id: null };
  } else if (wantedApprovalManager.length > 0) {
    // Re-sending whoever is ALREADY assigned is always allowed, even if they
    // are no longer a manager. It is not a change, so there is nothing to
    // validate — and refusing it would mean a past role change permanently
    // blocked saving working days, colour pace or Telegram.
    if (wantedApprovalManager === storedApprovalManager) {
      approvalManagerPatch = null;
    } else if (!isCompanyManager(wantedApprovalManager)) {
      return NextResponse.json(
        { ok: false, error: 'The approving manager must be a manager of this company.' },
        { status: 400 }
      );
    } else {
      approvalManagerPatch = { approval_manager_id: wantedApprovalManager };
    }
  }

  const basePatch = {
    working_days: workingDays,
    days_per_color_step: daysPerStep,
    telegram_bot_token: tgToken.length > 0 ? tgToken : null,
    telegram_chat_id: tgChat.length > 0 ? tgChat : null,
    alerts_enabled: alertsEnabled,
    telegram_enabled: telegramEnabled,
    attendance_objection_approver_id: approverId,
  };

  try {
    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('companies')
      .update({ ...basePatch, ...(approvalManagerPatch ?? {}) })
      .eq('id', companyId);

    if (res.error) {
      if (!isMissingRelationError(res.error)) throw new Error(res.error.message);

      // Pre-migration-#31. Save everything else rather than losing the whole
      // form, but do NOT claim the approver was stored: the admin would leave
      // believing gated permissions are usable when nothing can approve them.
      const retry = await supabase
        .from('companies')
        .update(basePatch)
        .eq('id', companyId);
      if (retry.error) throw new Error(retry.error.message);

      if (approvalManagerPatch?.approval_manager_id) {
        return NextResponse.json(
          {
            ok: true,
            warning: 'not_migrated',
            error:
              'Everything else was saved, but the approving manager could not be — that setting needs a database migration that has not run yet.',
          },
          { status: 200 }
        );
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Update settings error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
