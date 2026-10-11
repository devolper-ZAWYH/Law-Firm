import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import {
  APPROVAL_ACTION_BY_CAPABILITY,
  type ApprovalActionType,
  type CapabilityKey,
} from './capabilities';
import { hasCapabilityGrant, requiresApprovalFor } from './capabilityGrants';
import { isApprovalActionType, runApprovedAction } from './approvalExecutors';
import { insertNotifications } from './notifications';
import { isMissingRelationError } from './schemaCompat';

/**
 * CAPABILITY APPROVALS — the gate between "this employee may do X" and
 * "this employee may ASK to do X".
 *
 * THE FLOW
 *   1. A route authorizes the caller as usual. If they got through on a
 *      capability GRANT (not on being a manager/admin), it calls gateAction.
 *   2. gateAction asks whether that grant was handed out flagged. If not, it
 *      answers 'run' and the route does what it always did.
 *   3. If it was flagged, the action is parked as a row in
 *      capability_approval_requests and the company's approving manager is
 *      notified. The route returns 202 — nothing has happened yet.
 *   4. The approving manager decides. On approval the parked payload is
 *      replayed by its executor; on rejection nothing runs. Either way the
 *      employee is notified.
 *
 * WHO APPROVES — companies.approval_manager_id, and only a global admin may
 * write it (see the settings route). One approver per company handles every
 * gated capability. If none is assigned, a gated action is REFUSED rather than
 * allowed: a missing assignment is a configuration gap, and resolving it in
 * the permissive direction would turn "requires approval" into "does not".
 *
 * RE-CHECK ON EXECUTION — a request can sit for days, and a grant can be
 * revoked in that time. decideApprovalRequest therefore re-verifies that the
 * requester still holds the capability before running anything, so approving a
 * stale request cannot resurrect a permission that was taken away.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface ApprovalRequest {
  id: string;
  companyId: string;
  requesterId: string;
  capabilityKey: string;
  actionType: string;
  summaryEn: string;
  summaryAr: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

interface RawRow {
  id: string;
  company_id: string;
  requester_id: string;
  capability_key: string;
  action_type: string;
  payload: Record<string, unknown> | null;
  summary_en: string | null;
  summary_ar: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const SELECT_COLS =
  'id, company_id, requester_id, capability_key, action_type, summary_en, summary_ar, status, decided_by, decided_at, decision_note, created_at';

function mapRow(r: RawRow): ApprovalRequest {
  return {
    id: r.id,
    companyId: r.company_id,
    requesterId: r.requester_id,
    capabilityKey: r.capability_key,
    actionType: r.action_type,
    summaryEn: r.summary_en ?? '',
    summaryAr: r.summary_ar ?? '',
    status: (r.status as ApprovalStatus) ?? 'pending',
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// The approving manager (admin-assigned, one per company)
// ---------------------------------------------------------------------------

/** The company's approving manager, or null if the admin hasn't set one. */
export async function getApprovalManagerId(companyId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('companies')
    .select('approval_manager_id')
    .eq('id', companyId)
    .maybeSingle();
  if (res.error) {
    // DEPLOY SAFETY: the column arrives in migration #30.
    if (isMissingRelationError(res.error)) return null;
    throw new Error(res.error.message);
  }
  return (res.data as { approval_manager_id: string | null } | null)?.approval_manager_id ?? null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type GateDecision =
  /** Not gated — the caller performs the action now, exactly as before. */
  | { kind: 'run' }
  /** Parked. Nothing has happened; the approver has been notified. */
  | { kind: 'held'; request: ApprovalRequest }
  /** Gated, but the company has no approving manager. The action is refused. */
  | { kind: 'no_approver' };

export interface GateInput {
  userId: string;
  companyId: string;
  /** The capability the caller got through on. */
  capabilityKey: CapabilityKey;
  /** The already-validated arguments to replay on approval. */
  payload: Record<string, unknown>;
  summaryEn: string;
  summaryAr: string;
  /**
   * True when the caller is a baseline manager/admin of the company. Their
   * authority does not come from a grant, so it is never gated — the flag
   * lives on the grant, and they don't have one.
   */
  isPrivileged: boolean;
}

/**
 * Decide whether this action runs now or waits. See the file header for the
 * shape of the flow; the caller MUST honour a 'held' or 'no_approver' answer
 * by not performing the action.
 */
export async function gateAction(input: GateInput): Promise<GateDecision> {
  const { userId, companyId, capabilityKey, isPrivileged } = input;

  if (isPrivileged) return { kind: 'run' };

  const actionType = APPROVAL_ACTION_BY_CAPABILITY[capabilityKey];
  // A capability with no executor cannot be parked, so it cannot be gated —
  // the UI never offers the toggle for one (isApprovableCapability).
  if (!actionType) return { kind: 'run' };

  if (!(await requiresApprovalFor(userId, companyId, capabilityKey))) {
    return { kind: 'run' };
  }

  const approverId = await getApprovalManagerId(companyId);
  if (!approverId) return { kind: 'no_approver' };

  const request = await createApprovalRequest({
    companyId,
    requesterId: userId,
    capabilityKey,
    actionType,
    payload: input.payload,
    summaryEn: input.summaryEn,
    summaryAr: input.summaryAr,
  });

  await insertNotifications([
    {
      userId: approverId,
      companyId,
      taskId: null,
      type: 'approval_requested',
      level: 'warn',
      messageEn: `Approval needed: ${input.summaryEn}`,
      messageAr: `مطلوب موافقة: ${input.summaryAr}`,
    },
  ]);

  return { kind: 'held', request };
}

async function createApprovalRequest(input: {
  companyId: string;
  requesterId: string;
  capabilityKey: string;
  actionType: ApprovalActionType;
  payload: Record<string, unknown>;
  summaryEn: string;
  summaryAr: string;
}): Promise<ApprovalRequest> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('capability_approval_requests')
    .insert({
      company_id: input.companyId,
      requester_id: input.requesterId,
      capability_key: input.capabilityKey,
      action_type: input.actionType,
      payload: input.payload,
      summary_en: input.summaryEn,
      summary_ar: input.summaryAr,
    })
    .select(SELECT_COLS)
    .single();
  if (res.error) throw new Error(res.error.message);
  return mapRow(res.data as RawRow);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Requests in a company, newest first. Optionally narrowed to one status. */
export async function listApprovalRequests(
  companyId: string,
  status?: ApprovalStatus
): Promise<ApprovalRequest[]> {
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('capability_approval_requests')
    .select(SELECT_COLS)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);
  const res = await q;
  if (res.error) {
    if (isMissingRelationError(res.error)) return [];
    throw new Error(res.error.message);
  }
  return ((res.data as RawRow[] | null) ?? []).map(mapRow);
}

/** One person's own requests across a company, newest first. */
export async function listMyApprovalRequests(
  userId: string,
  companyId: string
): Promise<ApprovalRequest[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('capability_approval_requests')
    .select(SELECT_COLS)
    .eq('requester_id', userId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (res.error) {
    if (isMissingRelationError(res.error)) return [];
    throw new Error(res.error.message);
  }
  return ((res.data as RawRow[] | null) ?? []).map(mapRow);
}

export async function getApprovalRequest(id: string): Promise<
  (ApprovalRequest & { payload: Record<string, unknown> }) | null
> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('capability_approval_requests')
    .select(`${SELECT_COLS}, payload`)
    .eq('id', id)
    .maybeSingle();
  if (res.error) {
    if (isMissingRelationError(res.error)) return null;
    throw new Error(res.error.message);
  }
  if (!res.data) return null;
  const raw = res.data as RawRow;
  return { ...mapRow(raw), payload: raw.payload ?? {} };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export type DecisionResult =
  | { ok: true; status: 'approved' | 'rejected' }
  | {
      ok: false;
      code: 'not_found' | 'already_decided' | 'revoked' | 'execution_failed';
      error: string;
    };

/**
 * Approve or reject a pending request. On approval the parked payload is
 * replayed by its executor.
 *
 * ORDER MATTERS. The row is claimed (pending → approved) BEFORE the executor
 * runs, and the claim is conditional on the row still being pending. Two
 * approvers clicking at once therefore produce one execution and one
 * 'already_decided' — the guard is the database's, not a read-then-write race
 * in this process. If the executor then fails, the row is moved to 'failed'
 * with the reason, which is honest about what happened: the decision was made,
 * the action did not land.
 *
 * The caller (route) has already verified that `approverId` is the company's
 * assigned approving manager.
 */
export async function decideApprovalRequest(
  requestId: string,
  approverId: string,
  decision: 'approved' | 'rejected',
  note: string | null
): Promise<DecisionResult> {
  const request = await getApprovalRequest(requestId);
  if (!request) {
    return { ok: false, code: 'not_found', error: 'That request no longer exists.' };
  }
  if (request.status !== 'pending') {
    return {
      ok: false,
      code: 'already_decided',
      error: 'That request has already been decided.',
    };
  }

  // A grant revoked while the request sat waiting must not be honoured now.
  if (decision === 'approved') {
    const stillGranted = await hasCapabilityGrant(
      request.requesterId,
      request.companyId,
      request.capabilityKey
    );
    if (!stillGranted) {
      await finalize(requestId, approverId, 'rejected', 'The permission was revoked while this request was waiting.');
      await notifyRequester(request, 'approval_rejected', 'The permission was revoked while this request was waiting.');
      return {
        ok: false,
        code: 'revoked',
        error:
          'That employee no longer holds this permission, so the request was closed instead of carried out.',
      };
    }
  }

  const supabase = getSupabaseAdmin();
  const claim = await supabase
    .from('capability_approval_requests')
    .update({
      status: decision,
      decided_by: approverId,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data) {
    return {
      ok: false,
      code: 'already_decided',
      error: 'That request has already been decided.',
    };
  }

  if (decision === 'rejected') {
    await notifyRequester(request, 'approval_rejected', note);
    return { ok: true, status: 'rejected' };
  }

  if (!isApprovalActionType(request.actionType)) {
    await finalize(requestId, approverId, 'failed', 'This kind of request can no longer be carried out.');
    return {
      ok: false,
      code: 'execution_failed',
      error: 'This kind of request can no longer be carried out.',
    };
  }

  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await runApprovedAction(request.actionType, request.payload, {
      companyId: request.companyId,
      requesterId: request.requesterId,
    });
  } catch (err) {
    console.error('Approval execution threw:', err);
    result = { ok: false, error: 'The action could not be carried out.' };
  }

  if (!result.ok) {
    await finalize(requestId, approverId, 'failed', result.error);
    await notifyRequester(request, 'approval_rejected', result.error);
    return { ok: false, code: 'execution_failed', error: result.error };
  }

  await notifyRequester(request, 'approval_approved', null);
  return { ok: true, status: 'approved' };
}

/** Overwrite the decision fields — used when execution changes the outcome. */
async function finalize(
  requestId: string,
  approverId: string,
  status: ApprovalStatus,
  note: string | null
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('capability_approval_requests')
    .update({
      status,
      decided_by: approverId,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq('id', requestId);
  if (res.error) console.error('Finalize approval request error:', res.error.message);
}

async function notifyRequester(
  request: ApprovalRequest,
  type: 'approval_approved' | 'approval_rejected',
  note: string | null
): Promise<void> {
  const approved = type === 'approval_approved';
  const tailEn = note ? ` — ${note}` : '';
  await insertNotifications([
    {
      userId: request.requesterId,
      companyId: request.companyId,
      taskId: null,
      type,
      level: approved ? null : 'warn',
      messageEn: approved
        ? `Approved: ${request.summaryEn}`
        : `Not approved: ${request.summaryEn}${tailEn}`,
      messageAr: approved
        ? `تمت الموافقة: ${request.summaryAr}`
        : `لم تتم الموافقة: ${request.summaryAr}${tailEn}`,
    },
  ]);
}
