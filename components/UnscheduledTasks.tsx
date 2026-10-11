'use client';

import { useState } from 'react';
import {
  taskInitial,
  taskPersonName,
  type ClientTaskWithFile,
} from './taskTypes';
import { formatMinutes, minutesToHours } from './WorkloadCalendar';

/**
 * THE UNSCHEDULED PILE — every open task nobody has put on a day yet, sitting
 * beside the month so it can be dragged onto one.
 *
 * WHY IT SITS BESIDE THE CALENDAR RATHER THAN ON A TAB
 *   These two things are one job. The pile is the input and the month is the
 *   output, and a manager works by looking at Thursday's empty bar and moving
 *   something into it. Behind a tab the pile becomes a list nobody opens, and
 *   the work in it stops existing — which is precisely what happened when a
 *   task with no deadline had nowhere to appear.
 *
 * THE TIME CHIP IS EDITABLE HERE, ON PURPOSE
 *   A task with no estimate can be dragged onto a day and will add nothing to
 *   the load bar — it is on the calendar and invisible to it. Rather than
 *   refuse the drag, the chip is the one place the number can be supplied in
 *   the same motion, without opening the task. Clicking it turns it into a
 *   small number field; blurring or pressing Enter saves.
 */

export interface UnscheduledTasksProps {
  /** Already filtered by the caller (search + employee filter). */
  tasks: ClientTaskWithFile[];
  lang: 'en' | 'ar';
  /** Whether tasks may be dragged and their estimates edited. */
  canPlan: boolean;
  /** Open the task's edit modal. */
  onOpen: (task: ClientTaskWithFile) => void;
  /** Persist a new estimate (null clears it). */
  onSetHours: (taskId: string, hours: number | null) => void;
  /** The id currently being dragged, so the card can dim itself. */
  draggingId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  /**
   * A task was dropped ONTO the pile — take it off the calendar.
   *
   * The pile is both ends of the journey, not just the start of it. Dragging a
   * card onto a day already had a natural reverse, and making the reverse a
   * button instead would mean the same act is a drag one way and a click the
   * other, in the same view, for no reason a user could name.
   */
  onDropToUnscheduled: (taskId: string) => void;
  /**
   * Draw the assignee's initial on each card. False on My Tasks, where every
   * card belongs to the person reading it and the avatar says nothing.
   */
  showAssignee?: boolean;
}

export default function UnscheduledTasks({
  tasks,
  lang,
  canPlan,
  onOpen,
  onSetHours,
  draggingId,
  onDragStart,
  onDragEnd,
  onDropToUnscheduled,
  showAssignee = true,
}: UnscheduledTasksProps) {
  const ar = lang === 'ar';
  // Which card's hours chip is currently a text field, and what is typed in it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Highlighted while a task is held over the pile. Without it the only
  // feedback is the cursor, and a drop target you cannot see is one people
  // release next to rather than onto.
  const [dropActive, setDropActive] = useState(false);

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
    // Anything unusable leaves the task exactly as it was. Refusing silently
    // rather than showing an error: the chip is a two-second interaction, and
    // the previous value is still on screen to show nothing happened.
    // Whole minutes, and within what the column can hold (999.99 hours).
    if (!Number.isFinite(mins) || mins <= 0 || mins > 59999) return;
    const hours = minutesToHours(mins);
    if (hours !== tk.estimatedHours) onSetHours(tk.id, hours);
  }

  return (
    <aside
      className={`wl-pile${dropActive ? ' is-drop' : ''}`}
      aria-label={ar ? 'المهام غير المجدولة' : 'Unscheduled tasks'}
      onDragOver={
        canPlan
          ? (e) => {
              // A task dragged out of a day. preventDefault is what makes this
              // a valid drop target at all.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!dropActive) setDropActive(true);
            }
          : undefined
      }
      onDragLeave={canPlan ? () => setDropActive(false) : undefined}
      onDrop={
        canPlan
          ? (e) => {
              e.preventDefault();
              setDropActive(false);
              const id = e.dataTransfer.getData('text/plain');
              // Dropping a card that is ALREADY here is a no-op, not an
              // unschedule of something already unscheduled.
              if (id && !tasks.some((t) => t.id === id)) {
                onDropToUnscheduled(id);
              }
            }
          : undefined
      }
    >
      <div className="wl-pile-head">
        <div>
          <div className="wl-pile-title">{ar ? 'المهام' : 'Tasks'}</div>
          <div className="wl-pile-sub">
            {ar ? 'المهام غير المجدولة' : 'Unscheduled tasks'}
          </div>
        </div>
        <span className="files-tab-count">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <p className="dash-hint wl-pile-empty">
          {ar ? 'لا توجد مهام غير مجدولة.' : 'Nothing waiting to be scheduled.'}
        </p>
      ) : (
        <ul className="wl-pile-list">
          {tasks.map((tk) => {
            const who = taskPersonName(tk.assignee, lang);
            return (
              <li
                key={tk.id}
                className={`wl-card${draggingId === tk.id ? ' is-dragging' : ''}`}
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
                <div className="wl-card-top">
                  <span className="wl-card-title" dir="auto">
                    {tk.title}
                  </span>
                  {showAssignee && (
                    <span
                      className="access-avatar"
                      title={who}
                      aria-label={who}
                    >
                      {taskInitial(who)}
                    </span>
                  )}
                </div>
                <div className="wl-card-meta">
                  <span className="wl-chip" dir="auto">
                    {tk.file.client}
                  </span>
                  {/* Nothing to show a read-only viewer about an estimate that
                      was never set: a disabled button reading "set time" is an
                      offer they cannot take. */}
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
                      // LTR even in Arabic: "0.5 h" is a number with a unit,
                      // and an RTL paragraph reorders it to "h 0.5". Same rule
                      // the platform already applies to numbers, emails and
                      // times (see lib/i18n.ts).
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
                  <button
                    type="button"
                    className="wl-chip wl-chip-open"
                    onClick={() => onOpen(tk)}
                  >
                    {ar ? 'فتح' : 'Open'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
