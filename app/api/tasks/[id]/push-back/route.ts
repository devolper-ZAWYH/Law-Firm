import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  getPlatformUser,
  canAdmin,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import { getFileById } from '@/lib/platform/files';
import { getTaskCore, pushBackTask } from '@/lib/platform/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * POST /api/tasks/:id/push-back — rewind a task's colour by one step and give
 * it `days` working days before it advances again. Body: { days }.
 *
 * MANAGER OR ADMIN of the task's company. Not grantable: this reverses a signal
 * the whole colour system exists to produce, so it stays with the people
 * accountable for the work rather than becoming a permission to hand out.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated.' }, { status: 401 });
  }

  let body: { days?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 });
  }
  const days = typeof body.days === 'number' ? body.days : Number(body.days);
  if (!Number.isFinite(days) || days <= 0) {
    return NextResponse.json(
      { ok: false, error: 'Enter how many working days to grant.' },
      { status: 400 }
    );
  }

  try {
    const task = await getTaskCore(params.id);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    const file = await getFileById(task.fileId);
    if (!file) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    if (!canAdmin(pu) && !isManagerOfCompany(pu, file.companyId)) {
      return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
    }

    const result = await pushBackTask({
      taskId: task.id,
      days,
      actorId: pu.userId,
    });
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
      }
      if (result.code === 'bad_state') {
        return NextResponse.json(
          {
            ok: false,
            error: 'Only a task that is still open can be pushed back.',
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'Enter how many working days to grant.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true, grantedDays: result.grantedDays });
  } catch (err) {
    console.error('Push back task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
