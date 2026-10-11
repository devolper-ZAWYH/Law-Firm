import LogoMark from './LogoMark';

export const metadata = {
  title: 'Forgot Password — AlBaker Law Firm',
};

// Stub page for now. Password reset flow (email token) can be added later.
export default function ForgotPasswordPage() {
  return (
    <div className="auth-wrap">
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-logo">
            <LogoMark />
            <div>
              <h1>Password Assistance</h1>
              <p>DashBoard</p>
            </div>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            For security, password resets are currently handled by an
            administrator. Please contact your firm administrator to have your
            password reset.
          </p>
          <p style={{ fontSize: 14 }}>
            Email:{' '}
            <a href="mailto:info@albaker.qa">info@albaker.qa</a>
          </p>
          <div className="auth-footer">
            <a href="/login">← Back to sign in</a>
          </div>
        </div>
      </main>
      <footer className="page-footer">
        © {new Date().getFullYear()} Ali AlBaker Law Firm. All rights reserved.
      </footer>
    </div>
  );
}
