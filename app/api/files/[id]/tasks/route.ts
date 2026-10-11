import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { gateAction } from '@/lib/platform/approvals';
import { heldResponse, noApproverResponse } from '@/lib/platform/approvalResponses';
import {
  getPlatformUser,
  roleInCompany,
  isManagerOfCompany,
} from '@/lib/platform/auth';
import {
  getFileById,
  isFileAssignedToUser,
  type PlatformFile,
} from '@/lib/platform/files';
import {
  listFileMembers,
  listCompanyManagers,
  type AccessPerson,
} from '@/lib/platform/access';
import { listTasksForFile, createTask } from '@/lib/platform/tasks';
import { canCreateTaskOnFile } from '@/lib/platform/permissions';
import { usersOnLeaveOn, todayIso } from '@/lib/platform/leave';
import { notifyTaskCreated } from '@/lib/platform/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

/**
 * GET /api/files/:id/tasks — tasks on a file (with history) plus the pickers the
 * Add-task form needs: `assignees` (file members ∪ company managers) and
 * `approvers` (company managers). Company-isolated: a global admin OR a
 * manager of the file's company. 404 across the isolation boundary.
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(params.id);
  } catch (err) {
    console.error('File tasks (lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  const role = roleInCompany(pu, file.companyId);
  const isManager = isManagerOfCompany(pu, file.companyId);
  // A manager membership is required to CREATE a task (Admin does not create);
  // an employee explicitly granted can_create_task also qualifies to view.
  const privileged = role === 'admin' || role === 'manager';
  // Both guards go out together — neither answer feeds the other, and awaiting
  // them in turn costs an extra round trip to a distant database on every open.
  // `assigned` is not even asked for an admin or manager, for whom it is moot.
  const [canCreate, assigned] = await Promise.all([
    canCreateTaskOnFile(pu, file.companyId, isManager),
    privileged ? Promise.resolve(true) : isFileAssignedToUser(file.id, pu.userId),
  ]);
  if (
    !privileged &&
    // Narrowed: the grant is no longer enough on its own — an employee also has
    // to be assigned to this folder, so they cannot read another matter's tasks.
    (!canCreate || !assigned)
  ) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  try {
    const [tasks, members, managers, onLeave] = await Promise.all([
      listTasksForFile(file.id),
      listFileMembers(file.id),
      listCompanyManagers(file.companyId),
      // Joined the batch rather than awaited after it: today's leave list does
      // not depend on who the members turn out to be.
      usersOnLeaveOn(file.companyId, todayIso()),
    ]);

    // Assignees = members ∪ managers, deduped, members first. Each carries the
    // last day of any leave they are on RIGHT NOW, so the picker can show them
    // in red and refuse the selection (the server refuses it too — see
    // createTask in lib/platform/tasks.ts).
    const seen = new Set<string>();
    const assignees: (AccessPerson & { onLeaveUntil: string | null })[] = [];
    for (const p of [...members, ...managers]) {
      if (seen.has(p.userId)) continue;
      seen.add(p.userId);
      assignees.push({ ...p, onLeaveUntil: onLeave.get(p.userId) ?? null });
    }

    // WHO ASSIGNED IT is management information: a manager or admin sees it, an
    // employee does not. Stripped from the payload rather than hidden in the UI
    // — otherwise it is one devtools panel away from being read anyway.
    const seesAssigner = role === 'admin' || role === 'manager';
    const visibleTasks = seesAssigner
      ? tasks
      : tasks.map((tk) => ({ ...tk, createdBy: null }));

    return NextResponse.json({
      ok: true,
      tasks: visibleTasks,
      assignees,
      approvers: managers,
      canCreate,
      seesAssigner,
      currentUserId: pu.userId,
    });
  } catch (err) {
    console.error('File tasks error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/files/:id/tasks — a MANAGER of the file's company creates + assigns
 * a task. Body: { title, description?, assignee_id, approver_id }.
 *
 * Requires a MANAGER MEMBERSHIP in the file's company (spec §6: "Admin does NOT
 * create tasks"). A pure global admin (no membership) → 403; employees → 403.
 * Domain rules (assignee on file/manager; approver a manager) are validated in
 * the data layer. 404 across the isolation boundary.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }
  const pu = await getPlatformUser(session);
  if (!pu) {
    return NextResponse.json(
      { ok: false, error: 'Unauthenticated.' },
      { status: 401 }
    );
  }

  let body: {
    title?: unknown;
    description?: unknown;
    assignee_id?: unknown;
    approver_id?: unknown;
    due_at?: unknown;
    repeat_every_days?: unknown;
    excluded_from_color?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const descriptionRaw =
    typeof body.description === 'string' ? body.description.trim() : '';
  const description = descriptionRaw.length > 0 ? descriptionRaw : null;
  const assigneeId =
    typeof body.assignee_id === 'string' ? body.assignee_id.trim() : '';
  // SCHEDULING (migration #32), all optional.
  //   due_at            — an ISO date/datetime, or null to clear.
  //   repeat_every_days — a positive whole number of days; anything else is
  //                       treated as "does not repeat" rather than rejected,
  //                       because a 0 would mean "recur instantly".
  //   excluded_from_color — keeps a deliberate future reminder from driving the
  //                       folder's colour.
  const dueAtRaw = typeof body.due_at === 'string' ? body.due_at.trim() : '';
  const dueAtDate = dueAtRaw ? new Date(dueAtRaw) : null;
  const dueAt =
    dueAtDate && !Number.isNaN(dueAtDate.getTime()) ? dueAtDate.toISOString() : null;
  const repeatRaw = Number(body.repeat_every_days);
  const repeatEveryDays =
    Number.isInteger(repeatRaw) && repeatRaw > 0 && repeatRaw <= 3650
      ? repeatRaw
      : null;
  const excludedFromColor = body.excluded_from_color === true;

  const approverId =
    typeof body.approver_id === 'string' ? body.approver_id.trim() : '';

  if (!title || !assigneeId || !approverId) {
    return NextResponse.json(
      { ok: false, error: 'Title, assignee and approver are required.' },
      { status: 400 }
    );
  }

  let file: PlatformFile | null = null;
  try {
    file = await getFileById(params.id);
  } catch (err) {
    console.error('Create task (file lookup) error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  // Managers OPERATE (an actual manager membership, not just admin) — extendable
  // to an employee explicitly granted can_create_task.
  const isManager = isManagerOfCompany(pu, file.companyId);
  if (!(await canCreateTaskOnFile(pu, file.companyId, isManager))) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden.' },
      { status: 403 }
    );
  }

  try {
    // GATE. An employee holding 'tasks.create' as a "requires approval" grant
    // gets the task parked instead of created. Placed after every validation
    // above, so only a task that would actually have been created is parked —
    // and the executor re-runs the domain rules at approval time, since the
    // assignee may have gone on leave in the meantime.
    const gate = await gateAction({
      userId: pu.userId,
      companyId: file.companyId,
      capabilityKey: 'tasks.create',
      payload: {
        fileId: file.id,
        title,
        description,
        assigneeId,
        approverId,
        dueAt,
        repeatEveryDays,
        excludedFromColor,
      },
      summaryEn: `Create the task “${title}”`,
      summaryAr: `إنشاء المهمة «${title}»`,
      isPrivileged: isManager || roleInCompany(pu, file.companyId) === 'admin',
    });
    if (gate.kind === 'no_approver') return noApproverResponse();
    if (gate.kind === 'held') return heldResponse(gate.request.id);

    const result = await createTask({
      fileId: file.id,
      companyId: file.companyId,
      title,
      description,
      assigneeId,
      approverId,
      createdBy: pu.userId,
      dueAt,
      repeatEveryDays,
      excludedFromColor,
    });
    if (!result.ok) {
      if (result.code === 'assignee_on_leave') {
        return NextResponse.json(
          {
            ok: false,
            error: `That person is on leave until ${result.onLeaveUntil} — assign this task to someone else.`,
          },
          { status: 409 }
        );
      }
      if (result.code === 'bad_assignee') {
        return NextResponse.json(
          {
            ok: false,
            error: 'The assignee must be on this file or a manager of the company.',
          },
          { status: 400 }
        );
      }
      if (result.code === 'bad_approver') {
        return NextResponse.json(
          { ok: false, error: 'The approver must be a manager of this company.' },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { ok: false, error: 'Title, assignee and approver are required.' },
        { status: 400 }
      );
    }
    // Notify the named approver a new task now needs their eventual sign-off.
    // Gated by the company's alerts_enabled inside notifyTaskCreated;
    // best-effort — a failed notification must not break task creation.
    try {
      await notifyTaskCreated(result.task.id);
    } catch (notifyErr) {
      console.error('notifyTaskCreated failed:', notifyErr);
    }
    return NextResponse.json({ ok: true, task: result.task }, { status: 201 });
  } catch (err) {
    console.error('Create task error:', err);
    return NextResponse.json(
      { ok: false, error: 'Server error. Please try again.' },
      { status: 500 }
    );
  }
}
