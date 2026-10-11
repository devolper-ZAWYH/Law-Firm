'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDash } from './DashboardShell';
import { formatDate } from '@/lib/format';
import {
  formatTaskDate,
  taskPersonName,
  type ClientTaskWithFile,
  type TaskPersonWithCapacity,
} from './taskTypes';
import TaskCountdown from './TaskCountdown';
import TaskEditModal, { type EditableTask } from './TaskEditModal';
import WorkloadCalendar, {
  formatMinutes,
  parseDayKey,
  rangeLabel,
  shiftAnchor,
  tasksOn,
  type CalendarRange,
} from './WorkloadCalendar';
import UnscheduledTasks from './UnscheduledTasks';
import DayTasksDrawer from './DayTasksDrawer';
import PeopleFilter from './PeopleFilter';

/** Per-browser persistence of the calendar range. */
const RANGE_KEY = 'albaker.workloadRange.v1';

/** The ranges, shortest first, so the control reads as a zoom level. */
const RANGE_OPTIONS: { key: CalendarRange; en: string; ar: string }[] = [
  { key: 'day', en: 'Day', ar: 'يوم' },
  { key: 'week', en: 'Week', ar: 'أسبوع' },
  { key: 'biweek', en: '2 weeks', ar: 'أسبوعان' },
  { key: 'month', en: 'Month', ar: 'شهر' },
];

/**
 * Manager "Employee Tasks" view. Every open task across the ACTIVE company's
 * files, as a WORKLOAD CALENDAR: a month of per-person load bars with the
 * unscheduled pile beside it, so a manager can see who is overloaded on which
 * day and drag work off that day onto an emptier one.
 *
 * WHAT CHANGED FROM THE OLD CALENDAR, AND WHY
 *   It used to place each task on its DUE date (falling back to the day it was
 *   assigned) and print the titles in the cell. That drew a calendar of
 *   deadlines: every task appeared on the day it was already too late to start,
 *   the month said nothing about capacity, and a task with neither date landed
 *   on the day it happened to be created. The grid now shows LOAD against each
 *   person's working hours, and a task is on a day only when someone put it
 *   there. See WorkloadCalendar for the full note.
 *
 * The flat LIST view is unchanged and still one click away — it is the right
 * shape for scanning countdowns and editing in bulk, which a month grid is not.
 *
 * Active-company scoped; the server re-enforces isolation on every call here.
 */
export default function EmployeeTasksView() {
  const { t, lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id;
  const role = activeCompany?.role;
  // Planning (drag, estimates) is a manager/admin act — the API enforces the
  // same rule, and this only decides whether the affordances are drawn.
  const canPlan = role === 'admin' || role === 'manager';

  const [tasks, setTasks] = useState<ClientTaskWithFile[]>([]);
  const [people, setPeople] = useState<TaskPersonWithCapacity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editingTask, setEditingTask] = useState<EditableTask | null>(null);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  /** The date the grid is centred on; the range decides what is drawn around it. */
  const [anchor, setAnchor] = useState(() => new Date());
  /**
   * Month is the default — it is the frame a manager plans a workload in, and
   * the one this screen was built around. The shorter ranges are for reading a
   * specific week or day, which is a second question, asked later.
   */
  const [range, setRange] = useState<CalendarRange>('month');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RANGE_KEY);
      if (saved === 'day' || saved === 'week' || saved === 'biweek' || saved === 'month') {
        setRange(saved);
      }
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);
  const selectRange = useCallback((r: CalendarRange) => {
    setRange(r);
    try {
      window.localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* ignore persistence failures */
    }
  }, []);
  const [query, setQuery] = useState('');
  /**
   * Whose work to show. EMPTY = everyone, not nobody — a cleared filter is a
   * filter that is off (see PeopleFilter).
   */
  const [personFilter, setPersonFilter] = useState<string[]>([]);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) {
      setTasks([]);
      setPeople([]);
      setLoading(false);
      setLoadError(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/tasks/employee-overview?company_id=${encodeURIComponent(
          companyId
        )}`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTaskWithFile[];
        people?: TaskPersonWithCapacity[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.tasks)) {
        setLoadError(true);
        setTasks([]);
        setPeople([]);
      } else {
        setTasks(data.tasks);
        // Tolerated as absent: an older server (or a failed roster read) still
        // returns tasks, and a calendar with no rows is better than an error.
        setPeople(Array.isArray(data.people) ? data.people : []);
      }
    } catch {
      setLoadError(true);
      setTasks([]);
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Free-text filter across the things a manager actually knows about a task:
   * its title, the CLIENT (the CRM contact's name, which is what people call
   * the matter by), the opponent, and who it is with. Matching is
   * case-insensitive and accent-naive — good enough for a list this size, and
   * it keeps the box instant with no round trip.
   *
   * The PERSON filter is applied in the same pass. It narrows the tasks AND
   * (below) the rows each day cell draws, so picking one employee turns the
   * month into that person's month rather than leaving five empty bars in
   * every cell.
   */
  /*
    WHO HAS A ROW. The roster already excludes frozen accounts and anyone a
    manager has hidden from this calendar, and the board has to agree with
    itself: without this their tasks stayed in the unscheduled pile — draggable
    onto a grid with no row to receive them, so a drop made the task disappear
    — and their scheduled tasks were silently absent from the days.

    Guarded on the roster having actually loaded. `people` is best-effort (see
    the overview route), and an empty roster means "could not read it", not
    "nobody works here" — filtering against it then would blank the whole board.
  */
  const rosterIds = useMemo(
    () => (people.length > 0 ? new Set(people.map((p) => p.userId)) : null),
    [people]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((tk) => {
      if (rosterIds && (!tk.assignee || !rosterIds.has(tk.assignee.userId))) {
        return false;
      }
      if (
        personFilter.length > 0 &&
        !(tk.assignee && personFilter.includes(tk.assignee.userId))
      ) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        tk.title,
        tk.file.client,
        tk.file.opponent,
        tk.assignee ? taskPersonName(tk.assignee, lang) : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [tasks, query, personFilter, lang, rosterIds]);

  const shownPeople = useMemo(
    () =>
      personFilter.length > 0
        ? people.filter((p) => personFilter.includes(p.userId))
        : people,
    [people, personFilter]
  );

  const unscheduled = useMemo(
    () => filtered.filter((tk) => tk.scheduledDate === null),
    [filtered]
  );

  /**
   * Write a plan (a day, an estimate, or both) and reconcile.
   *
   * OPTIMISTIC: the card moves the instant it is dropped, because a drag that
   * visibly does nothing for a round trip reads as a drag that failed, and the
   * manager drops it again. On failure the change is rolled back and the reason
   * shown above the board — the same shape the Folders kanban already uses for
   * a rejected move.
   */
  const applyPlan = useCallback(
    async (
      taskId: string,
      patch: { scheduled_date?: string | null; estimated_hours?: number | null }
    ) => {
      const before = tasks.find((tk) => tk.id === taskId);
      if (!before) return;

      setPlanError(null);
      setTasks((prev) =>
        prev.map((tk) =>
          tk.id === taskId
            ? {
                ...tk,
                scheduledDate:
                  patch.scheduled_date !== undefined
                    ? patch.scheduled_date
                    : tk.scheduledDate,
                estimatedHours:
                  patch.estimated_hours !== undefined
                    ? patch.estimated_hours
                    : tk.estimatedHours,
              }
            : tk
        )
      );

      try {
        const res = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}/plan`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          setTasks((prev) =>
            prev.map((tk) => (tk.id === taskId ? before : tk))
          );
          setPlanError(
            data.error ||
              (ar ? 'تعذّر حفظ الجدولة.' : 'Could not save the schedule.')
          );
        }
      } catch {
        setTasks((prev) => prev.map((tk) => (tk.id === taskId ? before : tk)));
        setPlanError(t.networkError);
      }
    },
    [tasks, ar, t]
  );

  const onPlanTask = useCallback(
    (taskId: string, day: string) => {
      setDraggingId(null);
      applyPlan(taskId, { scheduled_date: day });
    },
    [applyPlan]
  );

  const onSetHours = useCallback(
    (taskId: string, hours: number | null) => {
      applyPlan(taskId, { estimated_hours: hours });
    },
    [applyPlan]
  );

  /**
   * DELETE a task, whatever its status. Admin/manager only — the server is the
   * authority and answers 403 for anyone else; this only decides whether the
   * button is drawn.
   *
   * Two-step, like the delete inside the task modal: the first click arms it,
   * the second does it. A single click would destroy a task's whole history
   * (its events, its notes, the record it was ever asked for) from a row in a
   * list, which is too easy for something that cannot be undone.
   */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const onDelete = useCallback(
    async (taskId: string) => {
      if (confirmDeleteId !== taskId) {
        setConfirmDeleteId(taskId);
        return;
      }
      setDeletingId(taskId);
      setPlanError(null);
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (res.status === 202) {
          // The caller holds 'tasks.delete' as an approval-required grant.
          // Nothing was deleted — say so and leave the task on screen.
          setPlanError(
            ar
              ? 'أُرسل طلب الحذف للاعتماد.'
              : 'The deletion was sent for approval.'
          );
        } else if (!res.ok || !data.ok) {
          setPlanError(
            data.error || (ar ? 'تعذّر حذف المهمة.' : 'Could not delete the task.')
          );
        } else {
          setTasks((prev) => prev.filter((tk) => tk.id !== taskId));
        }
      } catch {
        setPlanError(t.networkError);
      } finally {
        setDeletingId(null);
        setConfirmDeleteId(null);
      }
    },
    [confirmDeleteId, ar, t]
  );

  const toEditable = useCallback(
    (tk: ClientTaskWithFile): EditableTask => ({
      id: tk.id,
      title: tk.title,
      description: tk.description,
      fileId: tk.file.id,
      assignee: tk.assignee,
      approver: tk.approver,
    }),
    []
  );

  if (!activeCompany) {
    return (
      <>
        <h1 className="dash-title">{t.employeeTasksTitle}</h1>
        <p className="dash-subtitle">{t.employeeTasksSubtitle}</p>
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.selectCompanyFirst}
          </p>
        </div>
      </>
    );
  }

  /** The delete control, shared by the day panel and the list rows. */
  function deleteButton(tk: ClientTaskWithFile) {
    if (!canPlan) return null;
    return (
      <button
        type="button"
        className="task-row-edit is-danger"
        onClick={() => onDelete(tk.id)}
        disabled={deletingId === tk.id}
      >
        {deletingId === tk.id
          ? ar
            ? 'جارٍ الحذف…'
            : 'Deleting…'
          : confirmDeleteId === tk.id
          ? ar
            ? 'تأكيد'
            : 'Confirm'
          : ar
          ? 'حذف'
          : 'Delete'}
      </button>
    );
  }

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.employeeTasksTitle}</h1>
          <p className="dash-subtitle">{t.employeeTasksSubtitle}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="dash-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.taskSearchPlaceholder}
            aria-label={t.taskSearchPlaceholder}
            style={{ minWidth: 200 }}
          />
          {/* WHOSE TASKS. Sourced from the company roster, not from the
              tasks, so someone with an empty week can still be picked — and
              their empty row is the answer. Multi-select, because the question
              is usually about a FEW people: the two sharing a matter, the
              three on a filing. */}
          <PeopleFilter
            people={people}
            selected={personFilter}
            onChange={setPersonFilter}
            lang={lang}
          />
          <button
            type="button"
            className={view === 'calendar' ? 'dash-btn-gold' : 'dash-btn-ghost'}
            onClick={() => setView('calendar')}
          >
            {t.viewCalendar}
          </button>
          <button
            type="button"
            className={view === 'list' ? 'dash-btn-gold' : 'dash-btn-ghost'}
            onClick={() => setView('list')}
          >
            {t.viewList}
          </button>
        </div>
      </div>

      {planError && (
        <div className="dash-alert dash-alert-error" role="alert">
          {planError}
        </div>
      )}

      {loading ? (
        <div className="dash-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            …
          </p>
        </div>
      ) : loadError ? (
        <div className="dash-card dash-state-card">
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadTasks}
          </div>
          <button type="button" className="dash-btn-gold" onClick={load}>
            {t.retry}
          </button>
        </div>
      ) : view === 'calendar' ? (
        // The calendar renders even with no tasks at all: an empty month of
        // empty bars is a true and useful answer ("nobody has anything on"),
        // where an empty-state card would just hide the roster.
        <div className="wl-layout">
          <UnscheduledTasks
            tasks={unscheduled}
            lang={lang}
            canPlan={canPlan}
            onOpen={(tk) => setEditingTask(toEditable(tk))}
            onSetHours={onSetHours}
            draggingId={draggingId}
            onDragStart={setDraggingId}
            onDragEnd={() => setDraggingId(null)}
            onDropToUnscheduled={(taskId) => {
              setDraggingId(null);
              applyPlan(taskId, { scheduled_date: null });
            }}
          />

          <div className="dash-card wl-main">
            <div className="task-cal-bar">
              {/*
                THE LABEL FOLLOWS THE RANGE. These said "Previous month" and
                "Next month" whatever the range was, so on Week a screen reader
                announced a month and moved seven days. The visible label beside
                them already names the period; the accessible one now agrees.

                THE GLYPH MIRRORS. `‹` and `›` are literal characters and do not
                flip. Under RTL the row reverses, so the BACK button moves to
                the right while its arrow still pointed left — backwards, in the
                portal's default language. .cal-nav-arrow mirrors it.
              */}
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => setAnchor((a) => shiftAnchor(a, range, -1))}
                aria-label={ar ? 'السابق' : 'Previous'}
              >
                <span className="cal-nav-arrow" aria-hidden="true">
                  ‹
                </span>
              </button>
              <div className="task-cal-month">
                {rangeLabel(anchor, range, lang)}
              </div>
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => setAnchor((a) => shiftAnchor(a, range, 1))}
                aria-label={ar ? 'التالي' : 'Next'}
              >
                <span className="cal-nav-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => setAnchor(new Date())}
              >
                {t.today}
              </button>

              {/* HOW MUCH TIME TO SHOW. Fewer days means bigger cells: a month
                  answers "when is the pressure", a single day is the only
                  range with room to print each person's name. */}
              <div
                className="wl-range-toggle"
                role="group"
                aria-label={ar ? 'المدى' : 'Range'}
              >
                {RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`files-view-btn${
                      range === opt.key ? ' is-active' : ''
                    }`}
                    aria-pressed={range === opt.key}
                    onClick={() => selectRange(opt.key)}
                  >
                    {ar ? opt.ar : opt.en}
                  </button>
                ))}
              </div>
            </div>

            <WorkloadCalendar
              tasks={filtered}
              people={shownPeople}
              anchor={anchor}
              range={range}
              lang={lang}
              canPlan={canPlan}
              openDay={openDay}
              onOpenDay={(key) => setOpenDay((cur) => (cur === key ? null : key))}
              onPlanTask={onPlanTask}
            />
            {/* The opened day is a DRAWER (see DayTasksDrawer), not a panel
                below the grid. The panel pushed the calendar up as it opened,
                moving the day you had just clicked out from under the pointer,
                and on a six-week month it frequently opened below the fold —
                so clicking a day looked like it did nothing. */}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {/* Distinguish "nothing here" from "nothing MATCHED" — otherwise a
                typo in the search box reads as an empty company. */}
            {tasks.length === 0 ? t.noOpenTasksCompany : t.noTasksMatchSearch}
          </p>
        </div>
      ) : (
        <div className="dash-card" style={{ padding: 0 }}>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>{t.colTask}</th>
                  <th>{t.reqFile}</th>
                  <th>{t.reqEmployee}</th>
                  <th>{ar ? 'مجدولة' : 'Planned'}</th>
                  <th>{t.fileCreated}</th>
                  <th>{ar ? 'اللون التالي' : 'Next color'}</th>
                  <th aria-label={ar ? 'إجراءات' : 'Actions'} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((tk) => (
                  <tr key={tk.id}>
                    <td>{tk.title}</td>
                    <td className="dash-td-muted">
                      {tk.file.client} {t.versus} {tk.file.opponent}
                    </td>
                    <td>{taskPersonName(tk.assignee, lang)}</td>
                    <td className="dash-td-muted">
                      {/* Parsed as a LOCAL day, not a UTC instant — see
                          parseDayKey. The estimate is a SEPARATE span kept
                          LTR: joined into one Arabic string, "· 2 h" reorders
                          to "h 2 ·". */}
                      {tk.scheduledDate ? (
                        <>
                          <span dir="auto">
                            {formatDate(parseDayKey(tk.scheduledDate), lang)}
                          </span>
                          {tk.estimatedHours !== null && (
                            <>
                              {' · '}
                              <span dir="ltr">
                                {formatMinutes(tk.estimatedHours)} {ar ? 'د' : 'min'}
                              </span>
                            </>
                          )}
                        </>
                      ) : ar ? (
                        'غير مجدولة'
                      ) : (
                        'Unscheduled'
                      )}
                    </td>
                    <td className="dash-td-muted" dir="auto">
                      {formatTaskDate(tk.assignedAt, lang)}
                    </td>
                    <td>
                      <TaskCountdown
                        task={tk}
                        section={tk.file.section}
                        workingDays={tk.file.workingDays}
                        daysPerColorStep={tk.file.daysPerColorStep}
                      />
                    </td>
                    <td>
                      {/* EDIT stops at completion (the server locks an approved
                          task); DELETE does not — removing a task that should
                          never have been assigned is exactly the case that
                          arises after it has been signed off. */}
                      {tk.status !== 'approved' && (
                        <button
                          type="button"
                          className="task-row-edit"
                          onClick={() => setEditingTask(toEditable(tk))}
                        >
                          {ar ? 'تعديل' : 'Edit'}
                        </button>
                      )}
                      {deleteButton(tk)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {/* Rendered OUTSIDE the calendar branch so it overlays the page rather
          than sitting inside the card's layout flow. */}
      {view === 'calendar' && openDay && (
        <DayTasksDrawer
          dayKey={openDay}
          tasks={tasksOn(filtered, openDay)}
          lang={lang}
          canPlan={canPlan}
          onClose={() => setOpenDay(null)}
          onEdit={(tk) => setEditingTask(toEditable(tk))}
          onSetHours={onSetHours}
          onDelete={onDelete}
          onUnschedule={(taskId) => applyPlan(taskId, { scheduled_date: null })}
          deleteLabel={(taskId) =>
            deletingId === taskId
              ? ar
                ? 'جارٍ الحذف…'
                : 'Deleting…'
              : confirmDeleteId === taskId
              ? ar
                ? 'تأكيد'
                : 'Confirm'
              : ar
              ? 'حذف'
              : 'Delete'
          }
          deleteBusy={(taskId) => deletingId === taskId}
          draggingId={draggingId}
          onDragStart={setDraggingId}
          onDragEnd={() => setDraggingId(null)}
        />
      )}

      {editingTask && (
        <TaskEditModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={() => load()}
        />
      )}
    </>
  );
}
