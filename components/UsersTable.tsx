'use client';

import { useDash } from './DashboardShell';
import { formatDate } from '@/lib/format';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'manager' | 'user';
  created_at: string;
}

export default function UsersTable({ users }: { users: UserRow[] }) {
  const { t, lang } = useDash();

  return (
    <div className="dash-card">
      <div className="dash-section-header">
        <span className="dash-sq dash-sq-gold" aria-hidden="true" />
        {t.usersHeading}
        <span className="dash-count">{users.length}</span>
      </div>

      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>{t.colEmail}</th>
              <th>{t.colRole}</th>
              <th>{t.colCreated}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                {/* Accounts are keyed by email; fall back to username for the
                    legacy seeded 'admin'. Kept LTR. */}
                <td dir="ltr" className="dash-td-email">
                  {u.email || u.username}
                </td>
                <td>
                  <span
                    className={`dash-pill ${
                      u.role === 'admin'
                        ? 'dash-pill-gold'
                        : u.role === 'manager'
                          ? 'dash-pill-green'
                          : 'dash-pill-indigo'
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="dash-td-muted">{formatDate(u.created_at, lang)}</td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={3} className="dash-td-muted">
                  {t.noUsers}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
