'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatDate } from '@/lib/format';

/**
 * Admin "Access Requests" view (Phase 3). Lists PENDING requests to add
 * employees to files, across ALL companies (an admin oversees every company).
 * Approving creates the file_access grant; rejecting just closes the request.
 * Both mutations are ADMIN-only and re-checked server-side.
 */

interface ReqPerson {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
}
interface AccessRequest {
  id: string;
  file: {
    id: string;
    client: string;
    opponent: string;
    companyId: string;
    companyNameEn: string;
    companyNameAr: string;
  };
  employee: ReqPerson;
  requestedBy: ReqPerson;
  createdAt: string;
}

export default function AccessRequestsView() {
  const { t, lang } = useDash();

  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // The id currently being decided, plus a per-row error message.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const personName = useCallback(
    (p: ReqPerson) =>
      (lang === 'ar' ? p.fullNameAr : p.fullNameEn) ||
      p.fullNameEn ||
      p.username,
    [lang]
  );
  const companyName = (r: AccessRequest) =>
    lang === 'ar' ? r.file.companyNameAr : r.file.companyNameEn;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch('/api/access-requests?status=pending', {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        requests?: AccessRequest[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.requests)) {
        setLoadError(true);
        setRequests([]);
      } else {
        setRequests(data.requests);
      }
    } catch {
      setLoadError(true);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusyId(id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(
        `/api/access-requests/${encodeURIComponent(id)}/${action}`,
        { method: 'POST' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setRowError((prev) => ({ ...prev, [id]: data.error || t.couldNotDecide }));
        setBusyId(null);
        return;
      }
      // Drop the decided request from the queue.
      setRequests((prev) => prev.filter((r) => r.id !== id));
      setBusyId(null);
    } catch {
      setRowError((prev) => ({ ...prev, [id]: t.networkError }));
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.accessRequestsTitle}</h1>
          <p className="dash-subtitle">{t.accessRequestsSubtitle}</p>
        </div>
      </div>

      {loading ? (
        <div className="dash-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            …
          </p>
        </div>
      ) : loadError ? (
        <div className="dash-card dash-state-card">
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadRequests}
          </div>
          <button type="button" className="dash-btn-gold" onClick={load}>
            {t.retry}
          </button>
        </div>
      ) : requests.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.noAccessRequests}
          </p>
        </div>
      ) : (
        <div className="access-req-list">
          {requests.map((r) => {
            const busy = busyId === r.id;
            const err = rowError[r.id];
            return (
              <div key={r.id} className="access-req-card">
                <div className="access-req-main">
                  <div className="access-req-file">
                    {r.file.client} {t.versus} {r.file.opponent}
                  </div>
                  <div className="access-req-meta">
                    <span className="access-req-badge">{companyName(r)}</span>
                    <span className="access-req-metaitem">
                      <span className="dash-eyebrow">{t.reqEmployee}:</span>{' '}
                      {personName(r.employee)}
                    </span>
                    <span className="access-req-metaitem">
                      <span className="dash-eyebrow">{t.reqManager}:</span>{' '}
                      {personName(r.requestedBy)}
                    </span>
                    <span className="access-req-metaitem" dir="auto">
                      <span className="dash-eyebrow">{t.reqDate}:</span>{' '}
                      {formatDate(r.createdAt, lang)}
                    </span>
                  </div>
                  {err && (
                    <div
                      className="dash-alert dash-alert-error"
                      role="alert"
                      style={{ marginTop: 10 }}
                    >
                      {err}
                    </div>
                  )}
                </div>
                <div className="access-req-actions">
                  <button
                    type="button"
                    className="dash-btn-gold"
                    disabled={busy}
                    onClick={() => decide(r.id, 'approve')}
                  >
                    {busy ? t.approving : t.approve}
                  </button>
                  <button
                    type="button"
                    className="dash-btn-ghost"
                    disabled={busy}
                    onClick={() => decide(r.id, 'reject')}
                  >
                    {busy ? t.rejecting : t.reject}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
