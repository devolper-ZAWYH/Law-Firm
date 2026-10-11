'use client';

import { useEffect, useRef, useState } from 'react';
import {
  taskInitial,
  taskPersonName,
  type ClientTaskWithFile,
} from './taskTypes';
import { dayLabel, formatMinutes, minutesToHours } from './WorkloadCalendar';

/**
 * THE OPENED DAY, as a drawer over the calendar.
 *
 * A day cell shows LOAD — a bar per person and nothing else, because a month of
 * task titles at that size is unreadable. This is where the work behind the bar
 * is named, and it opens on the inline-end edge like the folder drawer, so the
 * two "look at one thing in detail" surfaces on this platform behave the same
 * way.
 *
 * IT REPLACES AN INLINE PANEL BELOW THE GRID. That panel pushed the calendar
 * up as it opened, so the day you had just clicked moved out from under the
 * pointer, and on a six-week month it often opened below the fold entirely —
 * you clicked a day and nothing appeared to happen.
 *
 * THE VEIL DOES NOT TAKE CLICKS, and that is load-bearing here rather than
 * cosmetic: the calendar behind stays live so another day can be opened
 * directly, and — the point of the drag work — a task can be pulled OUT of this
 * drawer and dropped onto the unscheduled pile or onto a different day.
 */
export interface DayTasksDrawerProps {
  /** The opened day, 'YYYY-MM-DD'. */
  dayKey: string;
  /** The tasks planned on it, already filtered by the caller. */
  tasks: ClientTaskWithFile[];
  lang: 'en' | 'ar';
  /** Whether tasks may be dragged out and re-planned (manager/admin). */
  canPlan: boolean;
  onClose: () => void;
  onEdit: (task: ClientTaskWithFile) => void;
  onDelete: (taskId: string) => void;
  /** Take it off the calendar entirely. */
  onUnschedule: (taskId: string) => void;
  /**
   * Set (or clear) the estimated hours.
   *
   * This drawer used to SHOW the estimate and only when one existed, so a task
   * dropped onto a day — which is exactly when a manager decides how long it
   * will take — could not be given a time at all. The chip was editable in the
   * unscheduled pile and became read-only the moment the task was scheduled,
   * which is backwards.
   */
  onSetHours: (taskId: string, hours: number | null) => void;
  /** Label for the delete control, which is two-step (Delete → Confirm). */
  deleteLabel: (taskId: string) => string;
  deleteBusy: (taskId: string) => boolean;
  draggingId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
}

export default function DayTasksDrawer({
  dayKey,
  tasks,
  lang,
  canPlan,
  onClose,
  onEdit,
  onDelete,
  onUnschedule,
  onSetHours,
  deleteLabel,
  deleteBusy,
  draggingId,
  onDragStart,
  onDragEnd,
}: DayTasksDrawerProps) {
  const ar = lang === 'ar';
  const panelRef = useRef<HTMLElement | null>(null);
  // Which row's hours chip is currently a text field, and what is typed in it.
  // Mirrors UnscheduledTasks so the same chip behaves the same way in both
  // places — click to edit, Enter or blur to commit, Escape to abandon.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  function beginEdit(tk: ClientTaskWithFile) {
    setEditingId(tk.id);
    setDraft(tk.estimatedHours === null ? '' : formatMinutes(tk.estimatedHours));
  }

  function commit(tk: ClientTaskWithFile) {
    setEditingId(null);
    const trimmed = draft.trim();
    // An emptied field means "no estimate", which is a real state — not a
    // reason to keep the old number.
    if (trimmed === '') {
      if (tk.estimatedHours !== null) onSetHours(tk.id, null);
      return;
    }
    const mins = Number(trimmed);
    // Anything unusable leaves the task as it was; the old value is still on
    // screen, which is its own answer.
    // Whole minutes, and within what the column can hold (999.99 hours).
    if (!Number.isFinite(mins) || mins <= 0 || mins > 59999) return;
    const hours = minutesToHours(mins);
    if (hours !== tk.estimatedHours) onSetHours(tk.id, hours);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Click away to dismiss — but NOT onto the calendar or the pile.
   *
   * Those two are the drawer's working surface. A click on another day must let
   * that day's own handler switch the drawer (if this closed first, clicking the
   * SAME day would close and immediately reopen it, and the toggle would never
   * shut). A press on the pile is the start of a drag landing there. Everything
   * else — the page header, the background — closes as expected.
   */
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const panel = panelRef.current;
      const target = e.target;
      if (!panel || !(target instanceof Node)) return;
      if (panel.contains(target)) return;
      const el = target instanceof Element ? target : target.parentElement;
      if (el?.closest('.wl-cal, .wl-pile')) return;
      onClose();
    };
    // Deferred a frame: the click that OPENED this drawer is still propagating.
    const id = window.setTimeout(
      () => document.addEventListener('pointerdown', onPointerDown),
      0
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  return (
    <>
      <div className="folder-drawer-scrim" aria-hidden="true" />
      <aside
        ref={panelRef}
        className="dash-modal folder-drawer day-drawer"
        role="dialog"
        // Not modal: the calendar and the pile behind it stay live on purpose,
        // so a task can be dragged out of here onto either of them.
        aria-modal="false"
        aria-label={dayLabel(dayKey, lang)}
      >
        <div className="dash-modal-head">
          <div>
            <div className="dash-eyebrow">
              {ar ? 'مهام اليوم' : 'Tasks on this day'}
            </div>
            <h2 className="day-drawer-title" dir="auto">
              {dayLabel(dayKey, lang)}
            </h2>
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

        {canPlan && tasks.length > 0 && (
          <p className="dash-hint day-drawer-hint">
            {ar
              ? 'اسحب مهمة إلى يوم آخر، أو إلى قائمة المهام غير المجدولة لإزالتها من التقويم.'
              : 'Drag a task onto another day, or onto the unscheduled list to take it off the calendar.'}
          </p>
        )}

        {tasks.length === 0 ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            {ar ? 'لا مهام في هذا اليوم.' : 'Nothing planned for this day.'}
          </p>
        ) : (
          <ul className="task-history-list">
            {tasks.map((tk) => {
              const who = taskPersonName(tk.assignee, lang);
              return (
                <li
                  key={tk.id}
                  className={`task-row is-open${
                    draggingId === tk.id ? ' is-dragging' : ''
                  }`}
                  draggable={canPlan}
                  onDragStart={
                    canPlan
                      ? (e) => {
                          e.dataTransfer.setData('text/plain', tk.id);
                          e.dataTransfer.effectAllowed = 'move';
                          onDragStart(tk.id);
                        }
                      : undefined
                  }
                  onDragEnd={canPlan ? onDragEnd : undefined}
                >
                  <div className="task-row-main">
                    <div className="task-row-title" dir="auto">
                      {tk.title}
                    </div>
                    <div className="task-row-meta">
                      <span className="task-row-who">
                        <span className="access-avatar" aria-hidden="true">
                          {taskInitial(who)}
                        </span>
                        {who}
                      </span>
                      <span className="task-row-date" dir="auto">
                        {tk.file.client}
                      </span>
                      {/* Nothing to show a read-only viewer about an estimate
                          that was never set: a disabled button reading "set
                          time" is an offer they cannot take. */}
                      {!canPlan && tk.estimatedHours === null ? null : editingId === tk.id ? (
                        <input
                          className="wl-hours-input"
                          type="number"
                          min="0"
                          step="5"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => commit(tk)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit(tk);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          aria-label={ar ? 'الوقت المقدّر بالدقائق' : 'Estimated minutes'}
                        />
                      ) : (
                        <button
                          type="button"
                          // dir="ltr": an RTL paragraph renders "0.5 h" as
                          // "h 0.5". A number and its unit stay Latin-ordered.
                          dir={tk.estimatedHours === null ? undefined : 'ltr'}
                          className={`wl-chip wl-chip-hours${
                            tk.estimatedHours === null ? ' is-unset' : ''
                          }`}
                          onClick={() => canPlan && beginEdit(tk)}
                          disabled={!canPlan}
                          title={ar ? 'الوقت المقدّر بالدقائق' : 'Estimated minutes'}
                        >
                          {tk.estimatedHours === null
                            ? ar
                              ? 'حدّد الوقت'
                              : 'set time'
                            : `${formatMinutes(tk.estimatedHours)} ${ar ? 'د' : 'min'}`}
                        </button>
                      )}
                    </div>
                  </div>
                  {canPlan && (
                    <button
                      type="button"
                      className="task-row-edit"
                      onClick={() => onUnschedule(tk.id)}
                      title={
                        ar
                          ? 'أعدها إلى غير المجدولة'
                          : 'Return it to the unscheduled list'
                      }
                    >
                      {ar ? 'إلغاء الجدولة' : 'Unschedule'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="task-row-edit"
                    onClick={() => onEdit(tk)}
                  >
                    {ar ? 'تعديل' : 'Edit'}
                  </button>
                  {canPlan && (
                    <button
                      type="button"
                      className="task-row-edit is-danger"
                      onClick={() => onDelete(tk.id)}
                      disabled={deleteBusy(tk.id)}
                    >
                      {deleteLabel(tk.id)}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </>
  );
}
