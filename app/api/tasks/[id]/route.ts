import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getPlatformUser, roleInCompany } from '@/lib/platform/auth';
import { getFileById } from '@/lib/platform/files';
import {
  getTaskCore,
  editTask,
  deleteTask,
  type TaskCore,
} from '@/lib/platform/tasks';
import { hasCapabilityGrant } from '@/lib/platform/capabilityGrants';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import type { CapabilityKey } from '@/lib/platform/capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * Resolve the task + its company and confirm the caller may act on it: a
 * manager/admin of that company, OR an employee explicitly granted the given
 * capability (tasks.edit for PATCH, tasks.delete for DELETE) via the
 * Permissions capability tree — that grant has no legacy boolean counterpart,
 * so it can only be checked through membership_capability_grants. Returns the
 * task on success, or a NextResponse to return on failure (401/403/404).
 */
async function authorizeManagerOnTask(
  taskId: string,
  requiredCapability: CapabilityKey
): Promise<
  | {
      ok: true;
      task: TaskCore;
      companyId: string;
      actorId: string;
      /** True when they got in on the ROLE, false when on a capability grant. */
      isPrivileged: boolean;
    }
  | { ok: false; res: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'Unauthenticated.' },
        { status: 401 }
      ),
    };
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'Unauthenticated.' },
        { status: 401 }
      ),
    };
  }

  const task = await getTaskCore(taskId);
  if (!task) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      ),
    };
  }

  const file = await getFileById(task.fileId);
  if (!file) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'Not found.' },
        { status: 404 }
      ),
    };
  }

  const role = roleInCompany(pu, file.companyId);
  const isPrivileged = role === 'admin' || role === 'manager';
  if (!isPrivileged) {
    // Not a baseline manager/admin — still allowed if this employee's
    // membership was explicitly granted the required capability.
    const granted =
      role === 'employee' &&
      (await hasCapabilityGrant(pu.userId, file.companyId, requiredCapability));
    if (!granted) {
      return {
        ok: false,
        res: NextResponse.json(
          { ok: false, error: 'Forbidden.' },
          { status: 403 }
        ),
      };
    }
  }

  return {
    ok: true,
    task,
    companyId: file.companyId,
    actorId: pu.userId,
    isPrivileged,
  };
}

/**
 * PATCH /api/tasks/:id — a MANAGER/admin of the task's company (or an
 * employee granted 'tasks.edit') EDITS a not-yet-completed task. Body (all
 * optional): { title, description, assignee_id, approver_id }. company_id and
 * the file are never editable.
 *
 * Guards (server is the source of truth):
 *   • 401 unauthenticated / 403 not a manager|admin of the task's company and
 *     not granted 'tasks.edit' (authorizeManagerOnTask, which also enforces
 *     per-company isolation).
 *   • 409 the task is COMPLETED ('approved') → locked, cannot edit.
 *   • 400 invalid field (empty title, or an assignee/approver that fails the
 *     domain rules: assignee on-file-or-manager, approver a manager).
 * A reassignment writes a 'reassigned' task_event (audit trail).
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  let body: {
    title?: unknown;
    description?: unknown;
    assignee_id?: unknown;
    approver_id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  // Only pass through fields the client actually sent (undefined = leave as is).
  const title = typeof body.title === 'string' ? body.title : undefined;
  const description =
    body.description === null
      ? null
      : typeof body.description === 'string'
      ? body.description
      : undefined;
  const assigneeId =
    typeof body.assignee_id === 'string' ? body.assignee_id.trim() : undefined;
  const approverId =
    typeof body.approver_id === 'string' ? body.approver_id.trim() : undefined;

  if (
    title === undefined &&
    description === undefined &&
    assigneeId === undefined &&
    approverId === undefined
  ) {
    return NextResponse.json(
      { ok: false, error: 'Nothing to update.' },
      { status: 400 }
    );
  }

  try {
    const auth = await authorizeManagerOnTask(params.id, 'tasks.edit');
    if (!auth.ok) return auth.res;

    const gate = await gateAction({
      userId: auth.actorId,
      companyId: auth.companyId,
      capabilityKey: 'tasks.edit',
      payload: {
        taskId: auth.task.id,
        fileId: auth.task.fileId,
        // Only the keys actually sent are parked, so an absent field still
        // means "leave as is" when the edit is finally replayed.
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(approverId !== undefined ? { approverId } : {}),
      },
      summaryEn: `Edit the task “${auth.task.title}”`,
      summaryAr: `تعديل المهمة «${auth.task.title}»`,
      isPrivileged: auth.isPrivileged,
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await editTask({
      taskId: auth.task.id,
      fileId: auth.task.fileId,
      companyId: auth.companyId,
      actorId: auth.actorId,
      title,
      description,
      assigneeId,
      approverId,
    });
    if (!result.ok) {
      if (result.code === 'not_found') {
        return NextResponse.json(
          { ok: false, error: 'Not found.' },
          { status: 404 }
        );
      }
      if (result.code === 'locked') {
        return NextResponse.json(
          {
            ok: false,
            code: 'locked',
            error: 'This task is completed and can no longer be edited.',
          },
          { status: 409 }
        );
      }
      if (result.code === 'assignee_on_leave') {
        return NextResponse.json(
          {
            ok: false,
            error: `That person is on leave until ${result.onLeaveUntil} — assign this task to someone else.`,
          },
          { status: 409 }
        );
      }
      if (result.code === 'bad_approver') {
        return NextResponse.json(
          { ok: false, error: 'The approver must be a manager of the company.' },
          { status: 400 }
        );
      }
      if (result.code === 'bad_assignee') {
        return NextResponse.json(
          {
            ok: false,
            error:
              'The assignee must be on this file or a manager of the company.',
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'Invalid request.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Edit task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/tasks/:id — a MANAGER/admin of the task's company, or an
 * employee granted 'tasks.delete', deletes it (cascades its events).
 *
 * GRANTABLE, AND GATEABLE. Deleting a task destroys its history — the events,
 * the notes, the record that the work was ever asked for — so it used to be
 * admin-only and absent from the capability tree. It is now grantable, with
 * that weight carried by the approval gate instead: whoever hands out
 * 'tasks.delete' chooses whether each use of it needs the company's approving
 * manager to sign off first (lib/platform/approvals.ts).
 *
 * Three outcomes:
 *   • 200 — deleted (caller is a manager/admin, or holds an ungated grant).
 *   • 202 — HELD. Nothing was deleted; a request is waiting for the approver.
 *   • 409 — gated, but the admin has assigned no approving manager, so there
 *     is nobody who could say yes. Refused rather than let through.
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const auth = await authorizeManagerOnTask(params.id, 'tasks.delete');
    if (!auth.ok) return auth.res;

    const gate = await gateAction({
      userId: auth.actorId,
      companyId: auth.companyId,
      capabilityKey: 'tasks.delete',
      payload: { taskId: auth.task.id },
      summaryEn: `Delete the task “${auth.task.title}”`,
      summaryAr: `حذف المهمة «${auth.task.title}»`,
      isPrivileged: auth.isPrivileged,
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    await deleteTask(auth.task.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
