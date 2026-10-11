'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useDash } from './DashboardShell';
import { taskPersonName, type TaskPerson } from './taskTypes';

/**
 * Manager/admin "Edit task" modal for a NOT-YET-COMPLETED task. Prefilled with
 * the current values; edits title, description, assignee and approver. The
 * server (PATCH /api/tasks/:id) re-enforces every rule — manager/admin of the
 * company, task not completed (409), and the assignee/approver domain checks —
 * so this UI is convenience only. Bilingual EN/AR; dir/logical layout is
 * inherited from the shell so it mirrors correctly in RTL.
 */

export interface EditableTask {
  id: string;
  title: string;
  description: string | null;
  fileId: string;
  assignee: TaskPerson | null;
  approver: TaskPerson | null;
}

/** Merge a current person into an options list if the endpoint omitted them
 * (e.g. an assignee since removed from the file), so the select still shows the
 * current value rather than silently dropping it. */
function withCurrent(
  list: TaskPerson[],
  current: TaskPerson | null
): TaskPerson[] {
  if (!current) return list;
  return list.some((p) => p.userId === current.userId)
    ? list
    : [current, ...list];
}

export default function TaskEditModal({
  task,
  onClose,
  onSaved,
}: {
  task: EditableTask;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { lang } = useDash();
  const ar = lang === 'ar';

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [assigneeId, setAssigneeId] = useState(task.assignee?.userId ?? '');
  const [approverId, setApproverId] = useState(task.approver?.userId ?? '');

  const [assignees, setAssignees] = useState<TaskPerson[]>(
    withCurrent([], task.assignee)
  );
  const [approvers, setApprovers] = useState<TaskPerson[]>(
    withCurrent([], task.approver)
  );
  const [optionsLoading, setOptionsLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deleting is destructive and un-undoable, so it takes two clicks: the first
  // arms it, the second does it.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [heldMessage, setHeldMessage] = useState<string | null>(null);

  // Load the eligible assignees (file members + managers) and approvers
  // (managers) for this task's file. The endpoint is manager/admin-gated, which
  // matches who may open this modal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOptionsLoading(true);
      try {
        const res = await fetch(
          `/api/files/${encodeURIComponent(task.fileId)}/tasks`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          assignees?: TaskPerson[];
          approvers?: TaskPerson[];
        };
        if (cancelled) return;
        if (res.ok && data.ok) {
          setAssignees(
            withCurrent(
              Array.isArray(data.assignees) ? data.assignees : [],
              task.assignee
            )
          );
          setApprovers(
            withCurrent(
              Array.isArray(data.approvers) ? data.approvers : [],
              task.approver
            )
          );
        }
      } catch {
        /* keep the current-value fallbacks */
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.fileId, task.assignee, task.approver]);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const trimmed = title.trim();
      if (!trimmed) {
        setError(ar ? 'العنوان مطلوب.' : 'A title is required.');
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: trimmed,
            description: description.trim() || null,
            assignee_id: assigneeId,
            approver_id: approverId,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          code?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          if (res.status === 409 || data.code === 'locked') {
            setError(
              ar
                ? 'اكتملت هذه المهمة ولا يمكن تعديلها.'
                : 'This task is completed and can no longer be edited.'
            );
          } else {
            setError(
              data.error || (ar ? 'تعذّر حفظ المهمة.' : 'Could not save the task.')
            );
          }
          setSaving(false);
          return;
        }
        setSaving(false);
        onSaved();
        onClose();
      } catch {
        setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
        setSaving(false);
      }
    },
    [ar, title, description, assigneeId, approverId, task.id, onSaved, onClose]
  );

  async function onDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    setHeldMessage(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        error?: string;
        messageAr?: string;
        message?: string;
      };
      // 202 — the caller holds 'tasks.delete' as a "requires approval" grant.
      // Nothing was deleted; say so and leave the task on screen, because
      // closing the modal would read as "done".
      if (res.status === 202 && data.code === 'pending_approval') {
        setHeldMessage(
          (ar ? data.messageAr : data.message) ||
            (ar
              ? 'أُرسل الطلب إلى المدير المعتمد.'
              : 'Sent to your approving manager.')
        );
        setConfirmingDelete(false);
        setDeleting(false);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error || (ar ? 'تعذّر حذف المهمة.' : 'Could not delete the task.'));
        setConfirmingDelete(false);
        setDeleting(false);
        return;
      }
      onSaved();
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setConfirmingDelete(false);
      setDeleting(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'تعديل المهمة' : 'Edit task'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="file-detail-title">
            {ar ? 'تعديل المهمة' : 'Edit task'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form className="task-form" onSubmit={onSubmit} noValidate>
          {error && (
            <div className="dash-alert dash-alert-error" role="alert">
              {error}
            </div>
          )}

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-task-title">
              {ar ? 'العنوان' : 'Title'}
            </label>
            <input
              id="edit-task-title"
              className="dash-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-task-desc">
              {ar ? 'الوصف' : 'Description'}{' '}
              <span className="dash-hint" style={{ display: 'inline' }}>
                {ar ? '(اختياري)' : '(optional)'}
              </span>
            </label>
            <textarea
              id="edit-task-desc"
              className="dash-input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-task-assignee">
              {ar ? 'الموظف المكلَّف' : 'Assigned employee'}
            </label>
            <select
              id="edit-task-assignee"
              className="dash-input"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              disabled={optionsLoading}
            >
              {assignees.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {taskPersonName(p, lang)}
                </option>
              ))}
            </select>
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-task-approver">
              {ar ? 'المعتمِد' : 'Approver'}
            </label>
            <select
              id="edit-task-approver"
              className="dash-input"
              value={approverId}
              onChange={(e) => setApproverId(e.target.value)}
              disabled={optionsLoading}
            >
              {approvers.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {taskPersonName(p, lang)}
                </option>
              ))}
            </select>
          </div>

          {heldMessage && (
            <div className="dash-alert" role="status" style={{ marginBottom: 10 }}>
              {heldMessage}
            </div>
          )}
          <div className="dash-modal-actions">
            {/* DELETE — visible to whoever the server would let through
                (manager/admin, or an employee granted 'tasks.delete'). It is
                left enabled for everyone and the 403 is surfaced as the error
                it is, rather than the modal trying to second-guess a decision
                the server makes authoritatively. */}
            <button
              type="button"
              className="dash-btn-ghost"
              style={{ marginInlineEnd: 'auto', color: '#B4443A' }}
              onClick={onDelete}
              disabled={saving || deleting}
            >
              {deleting
                ? ar
                  ? 'جارٍ الحذف…'
                  : 'Deleting…'
                : confirmingDelete
                ? ar
                  ? 'اضغط مجددًا للتأكيد'
                  : 'Click again to confirm'
                : ar
                ? 'حذف المهمة'
                : 'Delete task'}
            </button>
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={onClose}
              disabled={saving || deleting}
            >
              {ar ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="submit"
              className="dash-btn-gold"
              disabled={saving || !title.trim() || !assigneeId || !approverId}
            >
              {saving ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'حفظ' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
