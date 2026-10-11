'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import { formatDate } from '@/lib/format';
import TaskCountdown from '../TaskCountdown';
import TaskEditModal, { type EditableTask } from '../TaskEditModal';
import {
  statusColor,
  statusLabel,
  taskInitial,
  type ClientTask,
  type TaskPerson,
} from '../taskTypes';
import type { ClientFile } from '../FilesView';
import type { AssigneeOption } from './types';
import type { FileTasksState } from './useFileTasks';

/**
 * The folder's tasks — the second tab of the folder drawer: the Add-task form
 * (for whoever may create one) and the history, split Not done / Done.
 *
 * ON LEAVE: someone away appears in the assignee picker in red and cannot be
 * selected. That is the visible half of the rule; createTask refuses the same
 * assignment server-side, so a hand-posted request gets a 409 rather than a
 * task nobody is there to do.
 */
export default function TasksTab({
  file,
  canCreateTask,
  canEditTask,
  canPushBack,
  canDeleteTask,
  onTasksChanged,
  tasksState,
}: {
  file: ClientFile;
  canCreateTask: boolean;
  canEditTask: boolean;
  /** Manager/admin only — rewinding a colour is not a grantable permission. */
  canPushBack: boolean;
  /** Manager/admin only — delete an assigned task, at any status. */
  canDeleteTask: boolean;
  onTasksChanged: () => void;
  tasksState: FileTasksState;
}) {
  const { t, lang, identity } = useDash();
  const {
    tasks,
    assignees,
    approvers,
    currentUserId,
    seesAssigner,
    loading: tasksLoading,
    loadError: tasksLoadError,
    ownOnly,
    reload: loadTasks,
  } = tasksState;

  /**
   * Who "my task" means.
   *
   * currentUserId comes from the folder-wide tasks endpoint, which is REFUSED
   * for someone without the capability to see every task on a folder — exactly
   * the person the own-tasks fallback exists for. Their id would then be empty
   * and no row would ever match, so Mark done vanished for the only people
   * relying on it. The shell always knows who is signed in.
   */
  const viewerId = currentUserId || identity.userId;

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskApprover, setTaskApprover] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  // Scheduling. All optional — a task with none of these behaves exactly as
  // every task did before.
  const [taskDueAt, setTaskDueAt] = useState('');
  const [taskRepeatDays, setTaskRepeatDays] = useState('');
  const [taskNoColor, setTaskNoColor] = useState(false);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  // Manager/admin edit of a not-yet-completed task — or an employee explicitly
  // granted 'tasks.edit' (the `canEditTask` prop already folds in that rule).
  const [editingTask, setEditingTask] = useState<EditableTask | null>(null);
  // Push-back: which task's day-count box is open, its value, and any error.
  const [pushBackFor, setPushBackFor] = useState<string | null>(null);
  const [pushBackDays, setPushBackDays] = useState('3');
  const [pushingBack, setPushingBack] = useState(false);
  const [pushBackErr, setPushBackErr] = useState<string | null>(null);
  // Marking one's OWN task done, from the folder. The note is optional and the
  // box is opened per task, matching how My Tasks asks for it.
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState('');
  const [doneBusy, setDoneBusy] = useState<string | null>(null);
  const [doneErr, setDoneErr] = useState<string | null>(null);
  // Deleting an assigned task. Two-step (arm, then confirm) because it destroys
  // the task's whole history — its events, its notes, the record it was ever
  // asked for — and a single click on a row in a list is far too easy for
  // something with no undo.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const personName = useCallback(
    (p: TaskPerson) =>
      (lang === 'ar' ? p.fullNameAr : p.fullNameEn) || p.fullNameEn || p.username,
    [lang]
  );

  /** "Ahmed Abdulla — on leave until 2026-08-14" for someone away. */
  const assigneeLabel = useCallback(
    (p: AssigneeOption) =>
      p.onLeaveUntil
        ? `${personName(p)}${
            lang === 'ar'
              ? ` — في إجازة حتى ${p.onLeaveUntil}`
              : ` — on leave until ${p.onLeaveUntil}`
          }`
        : personName(p),
    [personName, lang]
  );

  // Default the approver to the current user once the pickers load (spec §6).
  useEffect(() => {
    if (showTaskForm && !taskApprover && currentUserId) {
      const isApprover = approvers.some((a) => a.userId === currentUserId);
      if (isApprover) setTaskApprover(currentUserId);
    }
  }, [showTaskForm, taskApprover, currentUserId, approvers]);

  const pickedAssignee = assignees.find((a) => a.userId === taskAssignee);
  const pickedIsOnLeave = pickedAssignee?.onLeaveUntil != null;

  async function onCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!taskTitle.trim() || !taskAssignee || !taskApprover) return;
    setSavingTask(true);
    setTaskErr(null);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskTitle.trim(),
          description: taskDesc.trim() || undefined,
          assignee_id: taskAssignee,
          approver_id: taskApprover,
          due_at: taskDueAt || null,
          repeat_every_days: taskRepeatDays ? Number(taskRepeatDays) : null,
          excluded_from_color: taskNoColor,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setTaskErr(data.error || t.couldNotSaveTask);
        setSavingTask(false);
        return;
      }
      // Reset the form and refresh both the list and the parent badge.
      setTaskTitle('');
      setTaskDesc('');
      setTaskAssignee('');
      setTaskApprover('');
      setShowTaskForm(false);
      setSavingTask(false);
      await loadTasks();
      onTasksChanged();
    } catch {
      setTaskErr(t.networkError);
      setSavingTask(false);
    }
  }

  async function onPushBack(taskId: string) {
    const days = Number(pushBackDays);
    if (!Number.isFinite(days) || days <= 0) return;
    setPushingBack(true);
    setPushBackErr(null);
    try {
      const res = await fetch(
        `/api/tasks/${encodeURIComponent(taskId)}/push-back`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setPushBackErr(data.error || t.networkError);
        setPushingBack(false);
        return;
      }
      setPushingBack(false);
      setPushBackFor(null);
      await loadTasks();
      // The folder's colour is derived from these tasks, so the parent has to
      // recompute too.
      onTasksChanged();
    } catch {
      setPushBackErr(t.networkError);
      setPushingBack(false);
    }
  }

  /**
   * Delete an assigned task. First click arms, second click does it.
   *
   * Offered on DONE tasks too, which is the point: editing is locked once a
   * task is approved, so until now a task that should never have been raised
   * became permanent the moment it was signed off, and the only way to remove
   * it was through the database.
   */
  async function onDeleteTask(taskId: string) {
    if (confirmDeleteId !== taskId) {
      setConfirmDeleteId(taskId);
      setDeleteErr(null);
      return;
    }
    setDeletingId(taskId);
    setDeleteErr(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (res.status === 202) {
        // Held for approval — nothing was deleted, so the task stays on screen.
        setDeleteErr(
          lang === 'ar'
            ? 'أُرسل طلب الحذف للاعتماد.'
            : 'The deletion was sent for approval.'
        );
      } else if (!res.ok || !data.ok) {
        setDeleteErr(
          data.error ||
            (lang === 'ar' ? 'تعذّر حذف المهمة.' : 'Could not delete the task.')
        );
      } else {
        await loadTasks();
        // The folder's colour and badge count are derived from these tasks.
        onTasksChanged();
      }
    } catch {
      setDeleteErr(t.networkError);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  /**
   * Mark a task of MINE done. Offered on this tab because the folder is where
   * someone is already looking when they finish the work — before this, the
   * only place to do it was My Tasks, and an employee opening their folder
   * could read the task but not complete it.
   */
  async function onMarkDone(taskId: string) {
    setDoneBusy(taskId);
    setDoneErr(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Optional — an empty note is accepted and stored as none.
        body: JSON.stringify({ note: doneNote.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setDoneErr(data.error || t.couldNotUpdateTask);
        return;
      }
      setDoneFor(null);
      setDoneNote('');
      await loadTasks();
      onTasksChanged();
    } catch {
      setDoneErr(t.networkError);
    } finally {
      setDoneBusy(null);
    }
  }

  // Split history: "Not done" (open + awaiting_approval) vs "Done" (approved).
  // Tasks arrive newest-first from the API; keep that order in both buckets.
  const notDoneTasks = tasks.filter((tk) => tk.status !== 'approved');
  const doneTasks = tasks.filter((tk) => tk.status === 'approved');

  function renderTaskRow(tk: ClientTask, isDone: boolean) {
    const who = tk.assignee ? personName(tk.assignee) : '—';
    return (
      <li key={tk.id} className={`task-row ${isDone ? 'is-done' : 'is-open'}`}>
        <span
          className="task-row-dot"
          style={{ background: statusColor(tk.status) }}
          aria-hidden="true"
        />
        <div className="task-row-main">
          <div className="task-row-title" dir="auto">{tk.title}</div>
          <div className="task-row-meta">
            <span className="task-row-who">
              <span className="access-avatar" aria-hidden="true">
                {taskInitial(who)}
              </span>
              {who}
            </span>
            <span className="task-row-status">{statusLabel(tk.status, t)}</span>
            {/* WHO ASSIGNED IT — managers and admins only; the server omits
                createdBy entirely for anyone else. */}
            {seesAssigner && tk.createdBy && (
              <span className="task-row-assigner" dir="auto">
                {lang === 'ar' ? 'أسندها' : 'assigned by'}{' '}
                {personName(tk.createdBy)}
              </span>
            )}
            <span className="task-row-date" dir="auto">
              {formatDate(tk.assignedAt, lang)}
            </span>
            <TaskCountdown
              task={tk}
              section={file.section}
              workingDays={file.workingDays}
              daysPerColorStep={file.daysPerColorStep}
            />
          </div>
          {/* The assignee's completion comment, from the 'marked_done' event. */}
          {tk.lastDoneNote && (
            <div className="task-row-note" dir="auto">
              <span className="dash-eyebrow">{t.doneNoteLabel}:</span>{' '}
              {tk.lastDoneNote}
            </div>
          )}
          {tk.lastSendBackNote && (
            <div className="task-row-note" dir="auto">
              <span className="dash-eyebrow">{t.sendBackNoteLabel}:</span>{' '}
              {tk.lastSendBackNote}
            </div>
          )}
        </div>
        {/* Push back — only an OPEN task has a running clock to rewind. */}
        {/* Also offered while a task is SUBMITTED: it is precisely the task
            that has been waiting on someone else which comes back already red
            when it is finally sent back. */}
        {(tk.status === 'open' || tk.status === 'awaiting_approval') &&
          canPushBack && (
          <button
            type="button"
            className="task-row-edit"
            onClick={() => {
              setPushBackFor(pushBackFor === tk.id ? null : tk.id);
              setPushBackDays('3');
              setPushBackErr(null);
            }}
          >
            {lang === 'ar' ? 'إرجاع' : 'Push back'}
          </button>
        )}
        {/* Edit — managers/admins, only while the task is NOT completed. */}
        {!isDone && canEditTask && (
          <button
            type="button"
            className="task-row-edit"
            onClick={() =>
              setEditingTask({
                id: tk.id,
                title: tk.title,
                description: tk.description,
                fileId: file.id,
                assignee: tk.assignee,
                approver: tk.approver,
              })
            }
          >
            {lang === 'ar' ? 'تعديل' : 'Edit'}
          </button>
        )}
        {/* MARK DONE — only on MY OWN task, and only while it is open. The
            folder is where someone is when they finish the work; before this
            the only place to complete a task was My Tasks. */}
        {tk.status === 'open' && tk.assignee?.userId === viewerId && (
          <button
            type="button"
            className="task-row-edit"
            onClick={() => {
              setDoneFor(doneFor === tk.id ? null : tk.id);
              setDoneNote('');
              setDoneErr(null);
            }}
          >
            {t.markDone}
          </button>
        )}
        {/* Delete — managers/admins, at ANY status (see canDeleteTask). */}
        {canDeleteTask && (
          <button
            type="button"
            className="task-row-edit is-danger"
            onClick={() => onDeleteTask(tk.id)}
            disabled={deletingId === tk.id}
          >
            {deletingId === tk.id
              ? lang === 'ar'
                ? 'جارٍ الحذف…'
                : 'Deleting…'
              : confirmDeleteId === tk.id
              ? lang === 'ar'
                ? 'تأكيد'
                : 'Confirm'
              : lang === 'ar'
              ? 'حذف'
              : 'Delete'}
          </button>
        )}
        {doneFor === tk.id && (
          <div className="task-pushback-panel">
            <p className="dash-hint" style={{ margin: '0 0 6px' }}>
              {t.doneNoteTitle}
            </p>
            <input
              className="dash-input"
              value={doneNote}
              onChange={(e) => setDoneNote(e.target.value)}
              placeholder={t.doneNotePlaceholder}
              aria-label={t.doneNoteTitle}
            />
            {doneErr && (
              <div
                className="dash-alert dash-alert-error"
                role="alert"
                style={{ marginTop: 6 }}
              >
                {doneErr}
              </div>
            )}
            <div className="dash-modal-actions" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => setDoneFor(null)}
                disabled={doneBusy === tk.id}
              >
                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                className="dash-btn-gold"
                onClick={() => onMarkDone(tk.id)}
                disabled={doneBusy === tk.id}
              >
                {doneBusy === tk.id ? t.saving : t.markDone}
              </button>
            </div>
          </div>
        )}
        {pushBackFor === tk.id && (
          <div className="task-pushback-panel">
            <p className="dash-hint" style={{ margin: '0 0 6px' }}>
              {lang === 'ar'
                ? 'كم يوم عمل قبل أن يتقدّم اللون مرة أخرى؟'
                : 'How many working days before the colour advances again?'}
            </p>
            {pushBackErr && (
              <div className="dash-alert dash-alert-error" role="alert">
                {pushBackErr}
              </div>
            )}
            <div className="access-add-row">
              <input
                className="dash-input"
                type="number"
                min={1}
                dir="ltr"
                aria-label={lang === 'ar' ? 'عدد الأيام' : 'Number of days'}
                value={pushBackDays}
                onChange={(e) => setPushBackDays(e.target.value)}
              />
              <button
                type="button"
                className="dash-btn-gold"
                disabled={pushingBack || !(Number(pushBackDays) > 0)}
                onClick={() => onPushBack(tk.id)}
              >
                {pushingBack
                  ? lang === 'ar'
                    ? 'جارٍ…'
                    : 'Working…'
                  : lang === 'ar'
                  ? 'إرجاع خطوة'
                  : 'Push back a step'}
              </button>
              <button
                type="button"
                className="dash-btn-ghost"
                disabled={pushingBack}
                onClick={() => setPushBackFor(null)}
              >
                {t.cancel}
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      <div className="file-detail-block" style={{ borderTop: 0, paddingTop: 0 }}>
        <div
          className="dash-page-head"
          style={{ marginBottom: 10, alignItems: 'center' }}
        >
          <div className="dash-eyebrow">{t.taskHistory}</div>
          {canCreateTask && !showTaskForm && (
            <button
              type="button"
              className="dash-btn-gold"
              onClick={() => setShowTaskForm(true)}
            >
              + {t.addTask}
            </button>
          )}
        </div>

        {/* Add-task form (manager only) */}
        {canCreateTask && showTaskForm && (
          <form className="task-form" onSubmit={onCreateTask} noValidate>
            {taskErr && (
              <div className="dash-alert dash-alert-error" role="alert">
                {taskErr}
              </div>
            )}
            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="tk-title">
                {t.taskTitleField}
              </label>
              <input
                id="tk-title"
                className="dash-input"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder={t.taskTitlePlaceholder}
                required
              />
            </div>
            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="tk-desc">
                {t.taskDescriptionField}{' '}
                <span className="dash-hint" style={{ display: 'inline' }}>
                  {t.optionalTag}
                </span>
              </label>
              <input
                id="tk-desc"
                className="dash-input"
                value={taskDesc}
                onChange={(e) => setTaskDesc(e.target.value)}
              />
            </div>
            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="tk-assignee">
                {t.taskAssignee}
              </label>
              <select
                id="tk-assignee"
                className="dash-input"
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                required
              >
                <option value="">{t.selectAssigneePlaceholder}</option>
                {assignees.map((p) => (
                  <option
                    key={p.userId}
                    value={p.userId}
                    disabled={p.onLeaveUntil !== null}
                    className={
                      p.onLeaveUntil !== null ? 'fd-assignee-on-leave' : undefined
                    }
                  >
                    {assigneeLabel(p)}
                  </option>
                ))}
              </select>
              {/* A disabled <option> cannot be relied on to render red in every
                  browser, and the state must never be invisible — so anyone away
                  is also named in red beneath the field. */}
              {assignees.some((p) => p.onLeaveUntil !== null) && (
                <p className="fd-on-leave-note" style={{ margin: '6px 0 0' }}>
                  {assignees
                    .filter((p) => p.onLeaveUntil !== null)
                    .map((p) => assigneeLabel(p))
                    .join(' · ')}
                </p>
              )}
            </div>
            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="tk-approver">
                {t.taskApprover}
              </label>
              <select
                id="tk-approver"
                className="dash-input"
                value={taskApprover}
                onChange={(e) => setTaskApprover(e.target.value)}
                required
              >
                <option value="">{t.selectApproverPlaceholder}</option>
                {approvers.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {personName(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="task-due">
                {t.taskDueDate}{' '}
                <span className="dash-hint" style={{ display: 'inline' }}>
                  {t.optionalTag}
                </span>
              </label>
              <input
                id="task-due"
                className="dash-input"
                type="date"
                value={taskDueAt}
                onChange={(e) => setTaskDueAt(e.target.value)}
              />
            </div>

            <div className="dash-field">
              <label className="dash-eyebrow" htmlFor="task-repeat">
                {t.taskRepeatEvery}{' '}
                <span className="dash-hint" style={{ display: 'inline' }}>
                  {t.optionalTag}
                </span>
              </label>
              <input
                id="task-repeat"
                className="dash-input"
                type="number"
                min={1}
                max={3650}
                value={taskRepeatDays}
                onChange={(e) => setTaskRepeatDays(e.target.value)}
                placeholder={t.taskRepeatPlaceholder}
              />
              <div className="dash-hint">{t.taskRepeatHint}</div>
            </div>

            <div className="dash-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={taskNoColor}
                  onChange={(e) => setTaskNoColor(e.target.checked)}
                />
                <span style={{ fontSize: 13.5 }}>{t.taskNoColor}</span>
              </label>
              <div className="dash-hint">{t.taskNoColorHint}</div>
            </div>

            <div className="dash-modal-actions">
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => {
                  setShowTaskForm(false);
                  setTaskErr(null);
                }}
                disabled={savingTask}
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                className="dash-btn-gold"
                disabled={
                  savingTask ||
                  !taskTitle.trim() ||
                  !taskAssignee ||
                  !taskApprover ||
                  pickedIsOnLeave
                }
              >
                {savingTask ? t.creatingTask : t.createTask}
              </button>
            </div>
          </form>
        )}

        {/* Seeing every task on a folder is its own capability. When the
            viewer does not hold it they get their OWN tasks here, and the tab
            says so rather than presenting a partial list as the whole. */}
        {ownOnly && (
          <p className="dash-hint" style={{ margin: '0 0 8px' }}>
            {lang === 'ar'
              ? 'تظهر هنا مهامك في هذا المجلد فقط.'
              : 'Showing only your own tasks on this folder.'}
          </p>
        )}

        {/* A refused or held deletion. Shown above the history rather than on
            the row, which is gone by the time a successful one resolves. */}
        {deleteErr && (
          <div className="dash-alert dash-alert-error" role="alert">
            {deleteErr}
          </div>
        )}

        {/* History: split Not done / Done */}
        {tasksLoading ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            …
          </p>
        ) : tasksLoadError ? (
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadTasks}
          </div>
        ) : tasks.length === 0 ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            {t.noTasksYet}
          </p>
        ) : (
          <>
            <div className="dash-eyebrow" style={{ margin: '4px 0 6px' }}>
              {t.tasksNotDone}
            </div>
            {notDoneTasks.length === 0 ? (
              <p className="dash-hint" style={{ margin: '0 0 10px' }}>
                —
              </p>
            ) : (
              <ul className="task-history-list">
                {notDoneTasks.map((tk) => renderTaskRow(tk, false))}
              </ul>
            )}

            <div className="dash-eyebrow" style={{ margin: '14px 0 6px' }}>
              {t.tasksDone}
            </div>
            {doneTasks.length === 0 ? (
              <p className="dash-hint" style={{ margin: 0 }}>
                —
              </p>
            ) : (
              <ul className="task-history-list">
                {doneTasks.map((tk) => renderTaskRow(tk, true))}
              </ul>
            )}
          </>
        )}
      </div>

      {editingTask && (
        <TaskEditModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={() => {
            // Reload the task list (new title/assignee/approver) and refresh the
            // parent so the derived folder color/countdown recompute off the edit.
            loadTasks();
            onTasksChanged();
          }}
        />
      )}
    </>
  );
}
