'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from './DashboardShell';

/**
 * APPROVALS INBOX — the held capability actions waiting on this person.
 *
 * Only the company's admin-assigned approving manager (and a global admin) has
 * anything here; the API answers everyone else with an empty list plus
 * `isApprover: false`, and this view says so plainly rather than rendering an
 * empty table that reads like "nothing pending". The difference matters: a
 * manager who is not the approver should learn that they are not the approver,
 * not conclude that their team has no requests.
 */

interface ApprovalRow {
  id: string;
  requesterId: string;
  requesterName: string;
  capabilityKey: string;
  actionType: string;
  summaryEn: string;
  summaryAr: string;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export default function ApprovalsView() {
  const { lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';

  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [isApprover, setIsApprover] = useState(false);
  const [approverAssigned, setApproverAssigned] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/approvals?company_id=${encodeURIComponent(companyId)}&scope=inbox`,
        { cache: 'no-store' }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'load failed');
      setRows((data.requests as ApprovalRow[]) ?? []);
      setIsApprover(data.isApprover === true);
      setApproverAssigned(data.approverAssigned === true);
    } catch {
      setError(ar ? 'تعذّر تحميل الطلبات.' : 'Could not load the requests.');
    } finally {
      setLoading(false);
    }
  }, [companyId, ar]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // A failed EXECUTION is not a failed click — the decision was recorded
        // and the reason belongs on screen, so reload to show the new state.
        setError(
          data.error ||
            (ar ? 'تعذّر تنفيذ القرار.' : 'The decision could not be carried out.')
        );
      }
      await load();
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
    } finally {
      setBusyId(null);
    }
  }

  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');
  const visible = showDecided ? decided : pending;

  if (!companyId) {
    return (
      <div className="dash-hint">
        {ar ? 'اختر شركة أولًا.' : 'Select a company first.'}
      </div>
    );
  }

  return (
    <div>
      <h1 className="dash-h1">{ar ? 'الموافقات' : 'Approvals'}</h1>
      <p className="dash-hint" style={{ marginBottom: 16 }}>
        {ar
          ? 'إجراءات طلبها موظفون مُنحوا صلاحية «تتطلب موافقة». لا يُنفَّذ أي منها قبل موافقتك.'
          : 'Actions requested by employees whose permission was granted as “requires approval”. None of them has happened yet.'}
      </p>

      {!isApprover && (
        <div className="dash-hint" style={{ marginBottom: 16 }}>
          {approverAssigned
            ? ar
              ? 'لست المدير المعتمد لهذه الشركة، لذا لا تصلك الطلبات هنا. يمكن للمسؤول تغيير ذلك من الإعدادات.'
              : 'You are not this company’s approving manager, so requests do not come to you. An admin can change that in Settings.'
            : ar
            ? 'لم يُعيَّن مدير معتمد لهذه الشركة بعد. حتى يُعيَّن، تُرفض كل الإجراءات التي تتطلب موافقة.'
            : 'No approving manager has been assigned for this company yet. Until one is, every action that requires approval is refused.'}
        </div>
      )}

      {error && (
        <div className="dash-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {isApprover && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className={showDecided ? 'dash-btn-ghost' : 'dash-btn-gold'}
            onClick={() => setShowDecided(false)}
          >
            {ar ? `بانتظار القرار (${pending.length})` : `Waiting (${pending.length})`}
          </button>
          <button
            type="button"
            className={showDecided ? 'dash-btn-gold' : 'dash-btn-ghost'}
            onClick={() => setShowDecided(true)}
          >
            {ar ? `تم البت فيها (${decided.length})` : `Decided (${decided.length})`}
          </button>
        </div>
      )}

      {loading ? (
        <div className="dash-hint">{ar ? 'جارٍ التحميل…' : 'Loading…'}</div>
      ) : visible.length === 0 ? (
        <div className="dash-hint">
          {showDecided
            ? ar
              ? 'لا توجد طلبات سابقة.'
              : 'No decided requests yet.'
            : ar
            ? 'لا توجد طلبات بانتظار القرار.'
            : 'Nothing is waiting for a decision.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((r) => (
            <div
              key={r.id}
              style={{
                border: '1px solid var(--border, #E4E1D9)',
                borderRadius: 10,
                padding: 14,
                background: 'var(--bg-card, #fff)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {(ar ? r.summaryAr : r.summaryEn) || r.actionType}
              </div>
              <div className="dash-hint">
                {ar ? 'طلبها' : 'Requested by'}: {r.requesterName || '—'} ·{' '}
                <span dir="ltr">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <div className="dash-hint">
                {ar ? 'الصلاحية' : 'Permission'}: <code>{r.capabilityKey}</code>
              </div>

              {r.status === 'pending' ? (
                isApprover && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="dash-btn-gold"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, 'approved')}
                    >
                      {busyId === r.id
                        ? ar
                          ? 'جارٍ…'
                          : 'Working…'
                        : ar
                        ? 'موافقة وتنفيذ'
                        : 'Approve & carry out'}
                    </button>
                    <button
                      type="button"
                      className="dash-btn-ghost"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, 'rejected')}
                    >
                      {ar ? 'رفض' : 'Reject'}
                    </button>
                  </div>
                )
              ) : (
                <div className="dash-hint" style={{ marginTop: 8 }}>
                  {statusLabel(r.status, ar)}
                  {r.decidedAt && (
                    <>
                      {' · '}
                      <span dir="ltr">{new Date(r.decidedAt).toLocaleString()}</span>
                    </>
                  )}
                  {r.decisionNote && <> — {r.decisionNote}</>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 'failed' is deliberately distinct from 'rejected': the approver said yes,
 *  and the action still did not land. Collapsing the two would misreport what
 *  happened to both the approver and the employee. */
function statusLabel(status: ApprovalRow['status'], ar: boolean): string {
  if (status === 'approved') return ar ? 'تمت الموافقة والتنفيذ' : 'Approved and carried out';
  if (status === 'rejected') return ar ? 'مرفوض' : 'Rejected';
  if (status === 'failed') return ar ? 'ووفِق عليه لكن تعذّر التنفيذ' : 'Approved, but could not be carried out';
  return status;
}
