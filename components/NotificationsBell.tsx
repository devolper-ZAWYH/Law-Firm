'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { Lang } from '@/lib/i18n';
import { formatDate } from '@/lib/format';

/**
 * In-app notifications bell (Phase 7). A small inbox in the sidebar footer that
 * shows an unread count and opens a list of the CURRENT USER's notifications
 * (bilingual message, relative time, mark-as-read). It fetches on mount and
 * polls every 60s (no websockets). Fully self-contained; degrades to an empty,
 * silent bell if the Phase-7 migration hasn't been applied (endpoint returns 0).
 */

interface Notification {
  id: string;
  companyId: string;
  taskId: string | null;
  type: string;
  level: string | null;
  messageEn: string | null;
  messageAr: string | null;
  isRead: boolean;
  createdAt: string;
}

const POLL_MS = 60_000;

function relativeTime(iso: string, ar: boolean): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const s = Math.max(0, Math.floor(diff / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60) return ar ? 'الآن' : 'just now';
  if (m < 60) return ar ? `منذ ${m} د` : `${m}m ago`;
  if (h < 24) return ar ? `منذ ${h} س` : `${h}h ago`;
  if (d < 7) return ar ? `منذ ${d} ي` : `${d}d ago`;
  return formatDate(iso, ar ? 'ar' : 'en');
}

export default function NotificationsBell({ lang }: { lang: Lang }) {
  const ar = lang === 'ar';
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok) {
        setItems(Array.isArray(data.notifications) ? data.notifications : []);
        setUnread(typeof data.unreadCount === 'number' ? data.unreadCount : 0);
      }
    } catch {
      /* best-effort; leave prior state */
    }
  }, []);

  // Fetch on mount + poll.
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Refresh when opening the panel.
  useEffect(() => {
    if (open) {
      setLoading(true);
      load().finally(() => setLoading(false));
    }
  }, [open, load]);

  // Click-away to close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function markAll() {
    // Optimistic.
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      /* ignore */
    }
    load();
  }

  async function markOne(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      /* ignore */
    }
  }

  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="dash-foot-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ar ? 'التنبيهات' : 'Notifications'}
        style={{ position: 'relative', width: '100%' }}
      >
        <span className="dash-nav-icon">
          <BellIcon />
        </span>
        <span>{ar ? 'التنبيهات' : 'Notifications'}</span>
        {unread > 0 && (
          <span aria-hidden="true" style={badgeStyle}>
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div style={panelStyle} dir={ar ? 'rtl' : 'ltr'}>
          <div style={panelHeader}>
            <span
              style={{
                fontWeight: 700,
                fontSize: 13.5,
                color: 'var(--text-primary, #232220)',
              }}
            >
              {ar ? 'التنبيهات' : 'Notifications'}
            </span>
            {items.some((n) => !n.isRead) && (
              <button
                type="button"
                onClick={markAll}
                style={linkBtn}
              >
                {ar ? 'تعليم الكل كمقروء' : 'Mark all read'}
              </button>
            )}
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {loading && items.length === 0 && (
              <div style={emptyStyle}>{ar ? 'جارٍ التحميل…' : 'Loading…'}</div>
            )}
            {!loading && items.length === 0 && (
              <div style={emptyStyle}>
                {ar ? 'لا توجد تنبيهات.' : 'No notifications yet.'}
              </div>
            )}
            {items.map((n) => {
              const msg = (ar ? n.messageAr : n.messageEn) || n.messageEn || n.messageAr || '';
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => !n.isRead && markOne(n.id)}
                  style={{
                    ...rowStyle,
                    cursor: n.isRead ? 'default' : 'pointer',
                    background: n.isRead
                      ? 'transparent'
                      : 'var(--bg-cell, #F3F2ED)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      ...dotStyle,
                      background: dotColor(n),
                      opacity: n.isRead ? 0.25 : 1,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13,
                        lineHeight: 1.4,
                        color: 'var(--text-primary, #232220)',
                        fontWeight: n.isRead ? 400 : 600,
                      }}
                    >
                      {msg}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--text-muted, #93908A)',
                        marginBlockStart: 3,
                      }}
                      dir="ltr"
                    >
                      {relativeTime(n.createdAt, ar)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function dotColor(n: Notification): string {
  if (n.level === 'critical' || n.type === 'overdue_critical') return '#C0563F';
  if (n.level === 'warn' || n.type === 'overdue_warn') return '#D9922B';
  if (n.type === 'task_sent_back') return '#C0563F';
  return 'var(--albaker-gold, #BD9446)';
}

const BellIcon = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const badgeStyle: CSSProperties = {
  position: 'absolute',
  insetInlineEnd: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 999,
  background: '#C0563F',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: '18px',
  textAlign: 'center',
};

const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  insetInlineStart: 0,
  insetInlineEnd: 0,
  background: 'var(--surface-card, #fff)',
  border: '1px solid var(--border, #E9E7E0)',
  borderRadius: 12,
  boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
  overflow: 'hidden',
  zIndex: 50,
};

const panelHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '1px solid var(--border, #E9E7E0)',
};

const linkBtn: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--albaker-gold, #BD9446)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  width: '100%',
  textAlign: 'start',
  border: 'none',
  borderBottom: '1px solid var(--border, #E9E7E0)',
  padding: '10px 12px',
};

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
  marginBlockStart: 5,
};

const emptyStyle: CSSProperties = {
  padding: '18px 12px',
  fontSize: 13,
  color: 'var(--text-muted, #93908A)',
  textAlign: 'center',
};
