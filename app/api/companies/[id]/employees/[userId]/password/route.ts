import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, canAdmin } from '@/lib/platform/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { hashPassword } from '@/lib/password';
import { bumpTokenVersion } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/companies/[id]/employees/[userId]/password — ADMIN ONLY.
 *
 * Set (or reset) the target person's login password. This is what ENABLES login
 * for directory accounts created with a placeholder ('!disabled') hash: once an
 * admin sets a real password here, the person can sign in with their email + it.
 *
 * We validate the target is a MEMBER of THIS company (404 otherwise) so an admin
 * can only manage people visible in this company's directory. The new plaintext
 * is bcrypt-hashed (cost 12, via lib/password) and we bump token_version to
 * invalidate any outstanding sessions the account may already hold.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu || !canAdmin(pu)) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }
  const companyId = params.id;
  const userId = params.userId;

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Password must be at least 8 characters / يجب أن تتكون كلمة المرور من 8 أحرف على الأقل',
      },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();

    // The target must be a member of THIS company.
    const memRes = await supabase
      .from('memberships')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (memRes.error) throw new Error(memRes.error.message);
    if (!memRes.data) {
      return NextResponse.json(
        { ok: false, error: 'This person is not a member of this company.' },
        { status: 404 }
      );
    }

    const password_hash = await hashPassword(password);
    const updRes = await supabase
      .from('app_users')
      .update({ password_hash })
      .eq('id', userId)
      .select('id')
      .single();
    if (updRes.error) throw new Error(updRes.error.message);

    // Invalidate any outstanding sessions for this account (best-effort).
    await bumpTokenVersion(userId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Set employee password error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
