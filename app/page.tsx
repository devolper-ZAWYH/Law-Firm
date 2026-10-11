import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getPlatformUser, landingForPlatformUser } from '@/lib/platform/auth';

export const dynamic = 'force-dynamic';

// Landing route: resolve the platform landing (admin/manager → /admin,
// employee → /me) if logged in, else send to login.
export default async function Home() {
  const session = await getSession();
  if (!session) redirect('/login');

  // Resolve outside the try so redirect()'s internal throw is never swallowed.
  let dest = '/admin';
  try {
    const pu = await getPlatformUser(session);
    dest = pu ? landingForPlatformUser(pu) : '/login';
  } catch (e) {
    // e.g. platform migration not yet applied. Fall through to /admin, whose
    // error boundary renders a friendly retry card instead of crashing here.
    console.error('Platform resolution failed at /:', e);
  }
  redirect(dest);
}
