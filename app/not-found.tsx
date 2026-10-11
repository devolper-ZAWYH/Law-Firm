export const metadata = { title: 'Not found — AlBaker Law Firm' };

export default function NotFound() {
  return (
    <div className="auth-wrap">
      <main className="auth-main">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <h1 style={{ margin: '0 0 6px', fontSize: 40, color: 'var(--navy-dark)' }}>
            404
          </h1>
          <p style={{ marginTop: 0, color: 'var(--muted)' }}>
            Page not found / الصفحة غير موجودة
          </p>
          <p style={{ marginTop: 18 }}>
            <a className="btn btn-gold" style={{ width: 'auto' }} href="/login">
              Back to sign in / العودة لتسجيل الدخول
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
