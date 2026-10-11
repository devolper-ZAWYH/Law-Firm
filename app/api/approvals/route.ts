import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin, roleInCompany } from '@/lib/platform/auth';
import {
  getApprovalManagerId,
  listApprovalRequests,
  listMyApprovalRequests,
  type ApprovalRequest,
  type ApprovalStatus,
} from '@/lib/platform/approvals';
import { getCompanyMemberBrief, memberDisplayName } from '@/lib/platform/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'failed'];

/**
 * GET /api/approvals?company_id=<uuid>&scope=inbox|mine&status=<s>
 *
 * TWO SCOPES, TWO DIFFERENT PERMISSION QUESTIONS:
 *
 *   scope=inbox — requests waiting on ME. Only the company's assigned
 *     approving manager (and a global admin, who can see anything) may read
 *     this. A manager who is NOT the assigned approver gets an empty list
 *     rather than a 403: they are a legitimate member asking a legitimate
 *     question ("anything for me?"), and the honest answer is "no".
 *
 *   scope=mine — MY OWN requests, whatever their state. Any member may read
 *     their own, and the query is pinned to their user id server-side.
 *
 * Requester names are resolved here so the inbox can say who asked without the
 * client needing a second round-trip per row.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  const companyId = req.nextUrl.searchParams.get('company_id')?.trim() ?? '';
  if (!companyId) {
    return NextResponse.json({ ok: false, error: 'company_id is required.' }, { status: 400 });
  }
  if (roleInCompany(pu, companyId) === null) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  const scope = req.nextUrl.searchParams.get('scope') === 'mine' ? 'mine' : 'inbox';
  const statusParam = req.nextUrl.searchParams.get('status');
  const status = STATUSES.includes(statusParam as ApprovalStatus)
    ? (statusParam as ApprovalStatus)
    : undefined;

  try {
    const approverId = await getApprovalManagerId(companyId);
    const isApprover = approverId === pu.userId || canAdmin(pu);

    let requests: ApprovalRequest[];
    if (scope === 'mine') {
      requests = await listMyApprovalRequests(pu.userId, companyId);
      if (status) requests = requests.filter((r) => r.status === status);
    } else if (!isApprover) {
      requests = [];
    } else {
      requests = await listApprovalRequests(companyId, status);
    }

    // Resolve each distinct requester once.
    const names = new Map<string, string>();
    await Promise.all(
      Array.from(new Set(requests.map((r) => r.requesterId))).map(async (id) => {
        const brief = await getCompanyMemberBrief(id, companyId);
        names.set(id, brief ? memberDisplayName(brief) : '');
      })
    );

    return NextResponse.json({
      ok: true,
      isApprover,
      approverAssigned: approverId !== null,
      requests: requests.map((r) => ({ ...r, requesterName: names.get(r.requesterId) ?? '' })),
    });
  } catch (err) {
    console.error('List approval requests error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
