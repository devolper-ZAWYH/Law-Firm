import LoginForm from './LoginForm';
import { safeNextPath } from '@/lib/safeRedirect';

export const metadata = {
  title: 'Sign In — AlBaker Law Firm',
};

// Middleware already redirects authenticated users away from /login.
export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  // Only a same-site absolute path is an acceptable post-login destination —
  // see lib/safeRedirect.ts for why `startsWith('/')` was not that test.
  const next = safeNextPath(searchParams.next);

  return (
    <div className="auth-wrap">
      <main className="auth-main">
        <LoginForm next={next} />
      </main>
      <footer className="page-footer">
        © {new Date().getFullYear()} Ali AlBaker Law Firm. All rights reserved.
      </footer>
    </div>
  );
}
