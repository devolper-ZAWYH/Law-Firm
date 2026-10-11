'use client';

import { useState } from 'react';

/**
 * The portal chooser is a plain preference, sent with the credentials and
 * acted on only AFTER they check out. It reveals nothing on its own: the
 * options are the same for everyone, and someone without PayLater access is
 * told so only once they have proved who they are (see app/api/login/route.ts).
 */
type Portal = 'main' | 'paylater';

export default function LoginForm({ next }: { next?: string }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [portal, setPortal] = useState<Portal>('main');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [logoOk, setLogoOk] = useState(true);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password, portal }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        redirect?: string;
        error?: string;
        notice?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error || 'Login failed. Please try again.');
        setLoading(false);
        return;
      }
      // A refused PORTAL is not a refused sign-in. The session is valid and the
      // server has already pointed at the main portal; say so plainly on the
      // way through rather than showing a red error for a boundary working as
      // intended.
      if (data.notice) {
        setNotice(data.notice);
        setLoading(false);
        window.setTimeout(() => {
          window.location.assign(data.redirect || next || '/');
        }, 2200);
        return;
      }
      // Full navigation so the new session cookie is picked up by middleware.
      window.location.assign(data.redirect || next || '/');
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-logo">
        {logoOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/albaker-logo.png"
            alt="Ali AlBaker Law Firm"
            width={720}
            height={415}
            fetchPriority="high"
            onError={() => setLogoOk(false)}
          />
        ) : (
          <div className="fallback" aria-hidden="true">
            AB
          </div>
        )}
        <div>
          <h1>Ali AlBaker Law Firm</h1>
          <p>DashBoard</p>
        </div>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <div className="form-success" role="status">
          {notice}
        </div>
      )}

      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="identifier">Email</label>
          <input
            id="identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="portal">Portal / البوابة</label>
          <select
            id="portal"
            name="portal"
            value={portal}
            onChange={(e) => setPortal(e.target.value as Portal)}
          >
            <option value="main">Main portal — البوابة الرئيسية</option>
            <option value="paylater">Collections — التحصيل</option>
          </select>
        </div>

        <button className="btn btn-gold" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>

      <div className="auth-footer">
        <a href="/forgot-password">Forgot password?</a>
      </div>
    </div>
  );
}
