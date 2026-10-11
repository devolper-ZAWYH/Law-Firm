'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDash } from '@/components/DashboardShell';

type Role = 'admin' | 'manager' | 'user';

export default function CreateUserForm() {
  const { t } = useDash();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedEmail(null);
    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, role }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || t.couldNotCreate);
        setLoading(false);
        return;
      }
      setCreatedEmail(email);
      setEmail('');
      setPassword('');
      setRole('user');
      setLoading(false);
      router.refresh(); // re-fetch the server-rendered user list
    } catch {
      setError(t.networkError);
      setLoading(false);
    }
  }

  return (
    <div className="dash-card">
      <div className="dash-section-header">
        <span className="dash-sq dash-sq-gold" aria-hidden="true" />
        {t.createUser}
      </div>

      {error && (
        <div className="dash-alert dash-alert-error" role="alert">
          {error}
        </div>
      )}
      {createdEmail && (
        <div className="dash-alert dash-alert-ok" role="status">
          {t.userCreated}{' '}
          <span dir="ltr" className="dash-strong">
            {createdEmail}
          </span>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate>
        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="cu-email">
            {t.email}
          </label>
          <input
            id="cu-email"
            className="dash-input"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <div className="dash-hint">{t.emailHint}</div>
        </div>

        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="cu-password">
            {t.password}
          </label>
          <input
            id="cu-password"
            className="dash-input"
            type="password"
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <div className="dash-hint">{t.passwordHint}</div>
        </div>

        <div className="dash-field">
          <label className="dash-eyebrow" htmlFor="cu-role">
            {t.roleField}
          </label>
          <select
            id="cu-role"
            className="dash-input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="user">{t.optRoleUser}</option>
            <option value="manager">{t.optRoleManager}</option>
            <option value="admin">{t.optRoleAdmin}</option>
          </select>
        </div>

        <button className="dash-btn-gold dash-btn-block" type="submit" disabled={loading}>
          {loading ? t.creating : t.createUser}
        </button>
      </form>
    </div>
  );
}
