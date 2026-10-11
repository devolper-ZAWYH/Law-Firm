'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDash } from './DashboardShell';
import WorkloadCalendar, {
  rangeLabel,
  shiftAnchor,
  tasksOn,
  type CalendarRange,
} from './WorkloadCalendar';
import DayTasksDrawer from './DayTasksDrawer';
import UnscheduledTasks from './UnscheduledTasks';
import FolderQuickDrawer from './FolderQuickDrawer';
import {
  formatTaskDate,
  taskInitial,
  taskPersonName,
  type ClientTaskWithFile,
  type TaskPerson,
  type TaskPersonWithCapacity,
} from './taskTypes';
import TaskCountdown from './TaskCountdown';

/**
 * State for the OPTIONAL follow-up task created via "Approve & Task": once the
 * manager approves task-1, this holds the file it belonged to and the SAME
 * employee (the assignee of task-1), pre-set as the responsible person for the
 * follow-up. Null when no follow-up form is open.
 */
interface FollowUpState {
  fileId: string;
  fileLabel: string;
  companyNameEn: string;
  companyNameAr: string;
  assignee: TaskPerson;
}

/**
 * Manager "My Tasks" view (Phase 4). Two blocks:
 *   1. "Awaiting my approval" — every task marked done where the manager is the
 *      NAMED approver, across all his companies. Approve, or send back with a
 *      required note (inline).
 *   2. "My open tasks" — tasks assigned to the manager himself that are still
 *      open, with a "Mark done" button (this is how a self-task advances to
 *      awaiting approval, so a manager can then approve his own work).
 *
 * All mutations are re-checked server-side (approve/send-back require the named
 * approver or admin; mark-done requires the assignee).
 */
export default function MyTasksView() {
  const { t, lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const role = activeCompany?.role;
  /*
    IS THIS PERSON AN APPROVER AT ALL?

    This screen serves two people. A manager opens it to approve work and to
    see what is coming; an employee opens it to see what they have been asked
    to do. The two approval sections were written for the first and rendered
    for both, so an ordinary employee — who approves nothing, and in most
    companies cannot be named an approver at all — was given two large cards
    explaining that nothing is awaiting their approval and nothing ever will
    be. Two empty answers to a question they never asked, above the one thing
    they came for.

    Shown when the person plausibly approves (manager or admin), or when they
    actually hold something either way — an employee who WAS named an approver
    still sees their items. Judged on the unfiltered lists, so typing in the
    search box narrows a section rather than making it disappear.
  */
  const approves = role === 'admin' || role === 'manager';

  const [awaiting, setAwaiting] = useState<ClientTaskWithFile[]>([]);
  // Tasks where the caller is approver but the assignee hasn't marked them
  // done yet — visible the moment the task is created, not just once it
  // reaches "awaiting my approval".
  const [pendingApproval, setPendingApproval] = useState<ClientTaskWithFile[]>([]);
  const [myOpen, setMyOpen] = useState<ClientTaskWithFile[]>([]);
  /*
    MY TASKS AS A CALENDAR — the same grid a manager reads on Employee Tasks,
    with one row: yours. A list answers "what do I owe"; the calendar answers
    "when", which is the question a week of work actually poses.

    Read-only here. Deciding WHICH day a task sits on is planning, and planning
    is the manager's act — the plan route enforces that, so offering the drag
    would only produce a control that 403s. What an employee gets is the plan
    as it stands, against their own hours.
  */
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [me, setMe] = useState<TaskPersonWithCapacity | null>(null);
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [range, setRange] = useState<CalendarRange>('week');
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Which folder is open in the drawer, by id — the task only carries a brief,
  // so the drawer fetches the folder itself (and that fetch is the access check).
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  // Which task's send-back note box is open, and its text.
  const [sendBackFor, setSendBackFor] = useState<string | null>(null);
  const [sendBackNote, setSendBackNote] = useState('');
  // Which self-task's "what did you do?" box is open, and its text.
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState('');

  // "Approve & Task": the optional follow-up create form, opened AFTER task-1 is
  // approved. Pre-fills the folder + the same employee; the manager fills the
  // rest. Reuses the same create API as the file-detail Add-task form.
  const [followUp, setFollowUp] = useState<FollowUpState | null>(null);
  // The just-approved task we are asking about. Purely a prompt: the approval
  // is already committed by the time this is set.
  const [followUpAsk, setFollowUpAsk] = useState<ClientTaskWithFile | null>(null);
  const [fuApprovers, setFuApprovers] = useState<TaskPerson[]>([]);
  // Everyone who may be given work on this folder — its members plus the
  // company's managers. The follow-up used to be pinned to whoever did the
  // task that was just approved, which is the common case but not the useful
  // one: the whole point of a follow-up is often that it goes to someone else.
  const [taskQuery, setTaskQuery] = useState('');
  const [fuAssignees, setFuAssignees] = useState<TaskPerson[]>([]);
  const [fuAssignee, setFuAssignee] = useState('');
  const [fuTitle, setFuTitle] = useState('');
  const [fuDesc, setFuDesc] = useState('');
  const [fuApprover, setFuApprover] = useState('');
  const [fuLoadingPickers, setFuLoadingPickers] = useState(false);
  const [fuSaving, setFuSaving] = useState(false);
  const [fuError, setFuError] = useState<string | null>(null);

  const companyName = useCallback(
    (tk: ClientTaskWithFile) =>
      lang === 'ar' ? tk.file.companyNameAr : tk.file.companyNameEn,
    [lang]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [awRes, pendingRes, mineRes] = await Promise.all([
        fetch('/api/tasks/awaiting-approval', { cache: 'no-store' }),
        fetch('/api/tasks/pending-approval', { cache: 'no-store' }),
        fetch('/api/tasks/mine', { cache: 'no-store' }),
      ]);
      const awData = (await awRes.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTaskWithFile[];
      };
      const pendingData = (await pendingRes.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTaskWithFile[];
      };
      const mineData = (await mineRes.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTaskWithFile[];
        me?: TaskPersonWithCapacity;
      };
      if (
        !awRes.ok ||
        !awData.ok ||
        !pendingRes.ok ||
        !pendingData.ok ||
        !mineRes.ok ||
        !mineData.ok
      ) {
        setLoadError(true);
        setAwaiting([]);
        setPendingApproval([]);
        setMyOpen([]);
      } else {
        setAwaiting(Array.isArray(awData.tasks) ? awData.tasks : []);
        setPendingApproval(Array.isArray(pendingData.tasks) ? pendingData.tasks : []);
        setMyOpen(
          (Array.isArray(mineData.tasks) ? mineData.tasks : []).filter(
            (tk) => tk.status === 'open'
          )
        );
        setMe(mineData.me ?? null);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Filters all three lists identically — a search that meant one thing under
   * "Awaiting my approval" and another under "My open tasks" would be worse
   * than no search at all.
   *
   * Covers what someone knows a task by: its title, and the folder it belongs
   * to (both sides of the title, since people refer to a matter by either).
   */
  const matchesQuery = useCallback(
    (tk: ClientTaskWithFile) => {
      const q = taskQuery.trim().toLowerCase();
      if (!q) return true;
      return [tk.title, tk.file.client, tk.file.opponent]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    },
    [taskQuery]
  );

  const awaitingShown = useMemo(() => awaiting.filter(matchesQuery), [awaiting, matchesQuery]);
  /** Draw the approval half of this screen at all — see `approves` above. */
  const showApprovalSections =
    approves || awaiting.length > 0 || pendingApproval.length > 0;
  const pendingShown = useMemo(
    () => pendingApproval.filter(matchesQuery),
    [pendingApproval, matchesQuery]
  );
  const myOpenShown = useMemo(() => myOpen.filter(matchesQuery), [myOpen, matchesQuery]);
  /** Open tasks nobody has put on a day. The calendar cannot draw them, so
   *  without this list they would simply not appear in the calendar view. */
  const unscheduledMine = useMemo(
    () => myOpenShown.filter((tk) => tk.scheduledDate === null),
    [myOpenShown]
  );
  const searching = taskQuery.trim() !== '';

  function clearRowError(id: string) {
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function act(
    id: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<boolean> {
    setBusyId(id);
    clearRowError(id);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/${path}`, {
        method: 'POST',
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setRowError((prev) => ({
          ...prev,
          [id]: data.error || t.couldNotUpdateTask,
        }));
        setBusyId(null);
        return false;
      }
      setBusyId(null);
      return true;
    } catch {
      setRowError((prev) => ({ ...prev, [id]: t.networkError }));
      setBusyId(null);
      return false;
    }
  }

  async function onApprove(tk: ClientTaskWithFile) {
    const ok = await act(tk.id, 'approve');
    if (!ok) return;
    // APPROVED ALREADY. The follow-up question is asked afterwards, never as a
    // precondition: whatever the manager answers — including closing the
    // dialog — the approval stands.
    //
    // Asked BEFORE the reload, not after. Awaiting load() first refetches every
    // task the manager can see, which took ~3 seconds against real data: the
    // row would vanish, the manager would move on, and a dialog would arrive
    // out of nowhere. The list refreshes behind the question instead.
    if (tk.assignee) setFollowUpAsk(tk);
    await load();
  }

  async function openFollowUp(tk: ClientTaskWithFile) {
    if (!tk.assignee) return;
    setFollowUp({
      fileId: tk.file.id,
      fileLabel: `${tk.file.client} ${t.versus} ${tk.file.opponent}`,
      companyNameEn: tk.file.companyNameEn,
      companyNameAr: tk.file.companyNameAr,
      assignee: tk.assignee,
    });
    setFuTitle('');
    setFuDesc('');
    setFuApprover('');
    setFuError(null);
    setFuApprovers([]);
    setFuAssignees([]);
    // Default to the person who just did the work — the likeliest answer, and
    // it keeps the previous behaviour as one click rather than a requirement.
    setFuAssignee(tk.assignee.userId);
    setFuLoadingPickers(true);
    // Load the approver picker (company managers) + default approver, reusing
    // the same endpoint the file-detail Add-task form uses. Literal select in
    // the route — no dynamic query added.
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(tk.file.id)}/tasks`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        approvers?: TaskPerson[];
        assignees?: TaskPerson[];
        currentUserId?: string;
      };
      if (res.ok && data.ok) {
        const managers = Array.isArray(data.approvers) ? data.approvers : [];
        setFuApprovers(managers);
        // Keep the just-approved assignee in the list even if the endpoint
        // omits them (e.g. they were since removed from the folder), so the
        // pre-selected value is never a dangling option.
        const people = Array.isArray(data.assignees) ? data.assignees : [];
        setFuAssignees(
          people.some((p) => p.userId === tk.assignee!.userId)
            ? people
            : [tk.assignee!, ...people]
        );
        // Default the approver to the current manager when they can approve.
        const cur = data.currentUserId;
        if (cur && managers.some((a) => a.userId === cur)) setFuApprover(cur);
      } else {
        setFuApprovers([]);
      }
    } catch {
      setFuApprovers([]);
    } finally {
      setFuLoadingPickers(false);
    }
  }

  function closeFollowUp() {
    setFollowUp(null);
    setFuApprovers([]);
    setFuTitle('');
    setFuDesc('');
    setFuApprover('');
    setFuError(null);
    setFuSaving(false);
  }

  async function onSubmitFollowUp() {
    if (!followUp) return;
    if (!fuTitle.trim() || !fuApprover || !fuAssignee) return;
    setFuSaving(true);
    setFuError(null);
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(followUp.fileId)}/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: fuTitle.trim(),
            description: fuDesc.trim() || undefined,
            assignee_id: fuAssignee || followUp.assignee.userId,
            approver_id: fuApprover,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setFuError(data.error || t.couldNotCreateTask);
        setFuSaving(false);
        return;
      }
      // task-2 created as a normal OPEN task, assigned to the same employee.
      closeFollowUp();
      await load();
    } catch {
      setFuError(t.networkError);
      setFuSaving(false);
    }
  }

  async function onSubmitSendBack(id: string) {
    if (!sendBackNote.trim()) return;
    const ok = await act(id, 'send-back', { note: sendBackNote.trim() });
    if (ok) {
      setSendBackFor(null);
      setSendBackNote('');
      await load();
    }
  }

  async function onMarkDone(id: string) {
    // The completion comment is OPTIONAL — empty is accepted.
    const ok = await act(id, 'done', { note: doneNote.trim() });
    if (ok) {
      setDoneFor(null);
      setDoneNote('');
      await load();
    }
  }

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.myTasksTitle}</h1>
          <p className="dash-subtitle">{t.myTasksSubtitle}</p>
        </div>
        <input
          className="dash-input"
          type="search"
          value={taskQuery}
          onChange={(e) => setTaskQuery(e.target.value)}
          placeholder={t.myTasksSearchPlaceholder}
          aria-label={t.myTasksSearchPlaceholder}
          style={{ minWidth: 240 }}
        />
      </div>

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
      ) : (
        <>
          {/* Awaiting my approval — manager/admin, or anyone who actually
              holds something to approve. See showApprovalSections. */}
          {showApprovalSections && (
          <div className="dash-card">
            <div className="dash-section-header">
              <span className="dash-sq dash-sq-gold" aria-hidden="true" />
              {t.awaitingMyApproval}
              <span className="dash-count">{awaitingShown.length}</span>
            </div>
            <p className="dash-hint" style={{ margin: '2px 0 12px' }}>
              {t.awaitingMyApprovalSubtitle}
            </p>

            {awaitingShown.length === 0 ? (
              <p className="dash-subtitle" style={{ margin: 0 }}>
                {searching ? t.noTasksMatchFilter : t.noAwaitingApproval}
              </p>
            ) : (
              <div className="task-card-list">
                {awaitingShown.map((tk) => {
                  const busy = busyId === tk.id;
                  const err = rowError[tk.id];
                  const who = taskPersonName(tk.assignee, lang);
                  return (
                    <div key={tk.id} className="task-card">
                      <div className="task-card-main">
                        <div className="task-card-title">{tk.title}</div>
                        <div className="task-card-meta">
                          <span className="access-req-badge">
                            {companyName(tk)}
                          </span>
                          {/* The folder OPENS, here as everywhere else — a
                              drawer over the list, never a page that replaces
                              it. See FolderQuickDrawer. */}
                          <button
                            type="button"
                            className="task-card-file is-openable"
                            onClick={() => setOpenFolderId(tk.file.id)}
                            title={ar ? 'افتح المجلد' : 'Open the folder'}
                          >
                            {tk.file.client} {t.versus} {tk.file.opponent}
                          </button>
                          <span className="task-row-who">
                            <span className="access-avatar" aria-hidden="true">
                              {taskInitial(who)}
                            </span>
                            {who}
                          </span>
                          <TaskCountdown
                            task={tk}
                            section={tk.file.section}
                            workingDays={tk.file.workingDays}
                            daysPerColorStep={tk.file.daysPerColorStep}
                          />
                        </div>
                        {/* What the employee wrote when marking it done — the
                            approver reads this before deciding. */}
                        {tk.lastDoneNote && (
                          <div className="task-row-note">
                            <span className="dash-eyebrow">
                              {t.doneNoteLabel}:
                            </span>{' '}
                            {tk.lastDoneNote}
                          </div>
                        )}
                        {tk.lastSendBackNote && (
                          <div className="task-row-note">
                            <span className="dash-eyebrow">
                              {t.sendBackNoteLabel}:
                            </span>{' '}
                            {tk.lastSendBackNote}
                          </div>
                        )}
                        {err && (
                          <div
                            className="dash-alert dash-alert-error"
                            role="alert"
                            style={{ marginTop: 10 }}
                          >
                            {err}
                          </div>
                        )}
                        {sendBackFor === tk.id && (
                          <div
                            className="access-add-row"
                            style={{ marginTop: 10 }}
                          >
                            <input
                              className="dash-input"
                              dir={lang === 'ar' ? 'rtl' : 'ltr'}
                              value={sendBackNote}
                              onChange={(e) => setSendBackNote(e.target.value)}
                              placeholder={t.sendBackNotePlaceholder}
                              aria-label={t.sendBackNotePlaceholder}
                              required
                            />
                            <button
                              type="button"
                              className="dash-btn-gold"
                              disabled={busy || !sendBackNote.trim()}
                              onClick={() => onSubmitSendBack(tk.id)}
                            >
                              {busy ? t.sendingBack : t.confirmSendBack}
                            </button>
                            <button
                              type="button"
                              className="dash-btn-ghost"
                              disabled={busy}
                              onClick={() => {
                                setSendBackFor(null);
                                setSendBackNote('');
                              }}
                            >
                              {t.cancel}
                            </button>
                          </div>
                        )}
                      </div>
                      {sendBackFor !== tk.id && (
                        <div className="task-card-actions">
                          {/* ONE approve button. It commits the approval, then
                              asks whether a follow-up task should be created —
                              so dismissing the question can never cost the
                              approval that already went through. */}
                          <button
                            type="button"
                            className="dash-btn-gold"
                            disabled={busy}
                            onClick={() => onApprove(tk)}
                          >
                            {busy ? t.approving : t.approve}
                          </button>
                          <button
                            type="button"
                            className="dash-btn-ghost"
                            disabled={busy}
                            onClick={() => {
                              clearRowError(tk.id);
                              setSendBackFor(tk.id);
                              setSendBackNote('');
                            }}
                          >
                            {t.sendBack}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Tasks you'll approve — still open, assignee hasn't marked them
              done yet. Read-only: nothing to do here until it reaches
              "awaiting my approval" above. */}
          {showApprovalSections && (
          <div className="dash-card" style={{ marginTop: 20 }}>
            <div className="dash-section-header">
              <span className="dash-sq dash-sq-gold" aria-hidden="true" />
              {t.tasksYouWillApprove}
              <span className="dash-count">{pendingShown.length}</span>
            </div>
            <p className="dash-hint" style={{ margin: '2px 0 12px' }}>
              {t.tasksYouWillApproveSubtitle}
            </p>

            {pendingShown.length === 0 ? (
              <p className="dash-subtitle" style={{ margin: 0 }}>
                {searching ? t.noTasksMatchFilter : t.noTasksYouWillApprove}
              </p>
            ) : (
              <div className="task-card-list">
                {pendingShown.map((tk) => {
                  const who = taskPersonName(tk.assignee, lang);
                  return (
                    <div key={tk.id} className="task-card">
                      <div className="task-card-main">
                        <div className="task-card-title">{tk.title}</div>
                        <div className="task-card-meta">
                          <span className="access-req-badge">
                            {companyName(tk)}
                          </span>
                          {/* The folder OPENS, here as everywhere else — a
                              drawer over the list, never a page that replaces
                              it. See FolderQuickDrawer. */}
                          <button
                            type="button"
                            className="task-card-file is-openable"
                            onClick={() => setOpenFolderId(tk.file.id)}
                            title={ar ? 'افتح المجلد' : 'Open the folder'}
                          >
                            {tk.file.client} {t.versus} {tk.file.opponent}
                          </button>
                          <span className="task-row-who">
                            <span className="access-avatar" aria-hidden="true">
                              {taskInitial(who)}
                            </span>
                            {who}
                          </span>
                          <span className="task-row-date" dir="auto">
                            {formatTaskDate(tk.assignedAt, lang)}
                          </span>
                          <TaskCountdown
                            task={tk}
                            section={tk.file.section}
                            workingDays={tk.file.workingDays}
                            daysPerColorStep={tk.file.daysPerColorStep}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* My open tasks (self-tasks to mark done) */}
          <div className="dash-card" style={{ marginTop: 20 }}>
            <div className="dash-section-header">
              <span className="dash-sq dash-sq-gold" aria-hidden="true" />
              {t.myOpenTasks}
              <span className="dash-count">{myOpenShown.length}</span>
            </div>
            <p className="dash-hint" style={{ margin: '2px 0 12px' }}>
              {t.myOpenTasksSubtitle}
            </p>

            {/* CALENDAR / LIST. The same pair the manager has on Employee
                Tasks, in the same order, so the two screens are read the same
                way. Calendar first because "when" is the question a week of
                work poses; the list is still the right shape for scanning
                countdowns and marking things done. */}
            <div
              className="files-filterbar"
              role="group"
              aria-label={ar ? 'طريقة العرض' : 'View'}
            >
              <button
                type="button"
                className={view === 'calendar' ? 'dash-btn-gold' : 'dash-btn-ghost'}
                aria-pressed={view === 'calendar'}
                onClick={() => setView('calendar')}
              >
                {t.viewCalendar}
              </button>
              <button
                type="button"
                className={view === 'list' ? 'dash-btn-gold' : 'dash-btn-ghost'}
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                {t.viewList}
              </button>
              {view === 'calendar' && (
                <>
                  <span style={{ flex: '1 1 auto' }} />
                  <button
                    type="button"
                    className="dash-btn-ghost"
                    aria-label={ar ? 'السابق' : 'Previous'}
                    onClick={() => setAnchor((a) => shiftAnchor(a, range, -1))}
                  >
                    <span className="cal-nav-arrow" aria-hidden="true">
                      ‹
                    </span>
                  </button>
                  <span className="dash-subtitle" style={{ margin: 0 }} dir="auto">
                    {rangeLabel(anchor, range, lang)}
                  </span>
                  <button
                    type="button"
                    className="dash-btn-ghost"
                    aria-label={ar ? 'التالي' : 'Next'}
                    onClick={() => setAnchor((a) => shiftAnchor(a, range, 1))}
                  >
                    <span className="cal-nav-arrow" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  <select
                    className="dash-input files-filter"
                    value={range}
                    aria-label={ar ? 'المدى' : 'Range'}
                    onChange={(e) => setRange(e.target.value as CalendarRange)}
                  >
                    <option value="day">{ar ? 'يوم' : 'Day'}</option>
                    <option value="week">{ar ? 'أسبوع' : 'Week'}</option>
                    <option value="biweek">{ar ? 'أسبوعان' : '2 weeks'}</option>
                    <option value="month">{ar ? 'شهر' : 'Month'}</option>
                  </select>
                </>
              )}
            </div>

            {view === 'calendar' ? (
              /*
                EVERY TASK HAS SOMEWHERE TO BE.

                The calendar can only draw a task that sits on a day, so on its
                own it silently hides everything nobody has scheduled — which,
                for an employee, is most of what they have been asked to do. The
                pile beside it holds exactly those, so the view answers "what do
                I owe" as well as "when".

                Same two-part layout the manager reads on Employee Tasks, and
                read-only for the same reason: choosing the day is planning, the
                plan route enforces that, and a drag that 403s is worse than no
                drag at all.
              */
              <div className="wl-layout is-stacked">
                <UnscheduledTasks
                  tasks={unscheduledMine}
                  lang={lang}
                  canPlan={false}
                  showAssignee={false}
                  onOpen={(tk) => setOpenFolderId(tk.file.id)}
                  onSetHours={() => {}}
                  draggingId={null}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onDropToUnscheduled={() => {}}
                />
                <div className="wl-main">
                  {/* One row — the viewer's. `me` can be absent if the capacity
                      read failed; the grid still draws, against the platform
                      default. */}
                  <WorkloadCalendar
                    tasks={myOpenShown}
                    people={me ? [me] : []}
                    anchor={anchor}
                    range={range}
                    lang={lang}
                    canPlan={false}
                    openDay={openDay}
                    onOpenDay={(day) => setOpenDay((d) => (d === day ? null : day))}
                    onPlanTask={() => {}}
                  />
                </div>
              </div>
            ) : myOpenShown.length === 0 ? (
              <p className="dash-subtitle" style={{ margin: 0 }}>
                {searching ? t.noTasksMatchFilter : t.noMyOpenTasks}
              </p>
            ) : (
              <div className="task-card-list">
                {myOpenShown.map((tk) => {
                  const busy = busyId === tk.id;
                  const err = rowError[tk.id];
                  return (
                    <div key={tk.id} className="task-card is-open">
                      <div className="task-card-main">
                        <div className="task-card-title">{tk.title}</div>
                        <div className="task-card-meta">
                          <span className="access-req-badge">
                            {companyName(tk)}
                          </span>
                          {/* The folder OPENS, here as everywhere else — a
                              drawer over the list, never a page that replaces
                              it. See FolderQuickDrawer. */}
                          <button
                            type="button"
                            className="task-card-file is-openable"
                            onClick={() => setOpenFolderId(tk.file.id)}
                            title={ar ? 'افتح المجلد' : 'Open the folder'}
                          >
                            {tk.file.client} {t.versus} {tk.file.opponent}
                          </button>
                          <span className="task-row-date" dir="auto">
                            {formatTaskDate(tk.assignedAt, lang)}
                          </span>
                          <TaskCountdown
                            task={tk}
                            section={tk.file.section}
                            workingDays={tk.file.workingDays}
                            daysPerColorStep={tk.file.daysPerColorStep}
                          />
                        </div>
                        {tk.lastSendBackNote && (
                          <div className="task-row-note">
                            <span className="dash-eyebrow">
                              {t.sendBackNoteLabel}:
                            </span>{' '}
                            {tk.lastSendBackNote}
                          </div>
                        )}
                        {err && (
                          <div
                            className="dash-alert dash-alert-error"
                            role="alert"
                            style={{ marginTop: 10 }}
                          >
                            {err}
                          </div>
                        )}
                        {doneFor === tk.id && (
                          <div style={{ marginTop: 10 }}>
                            <label
                              className="dash-eyebrow"
                              htmlFor={`my-done-note-${tk.id}`}
                            >
                              {t.doneNoteTitle}
                            </label>
                            <textarea
                              id={`my-done-note-${tk.id}`}
                              className="dash-input"
                              dir={lang === 'ar' ? 'rtl' : 'ltr'}
                              rows={3}
                              style={{ marginTop: 6, width: '100%' }}
                              value={doneNote}
                              onChange={(e) => setDoneNote(e.target.value)}
                              placeholder={t.doneNotePlaceholder}
                            />
                            <div className="task-card-actions">
                              <button
                                type="button"
                                className="dash-btn-gold"
                                disabled={busy}
                                onClick={() => onMarkDone(tk.id)}
                              >
                                {busy ? t.markingDone : t.confirmMarkDone}
                              </button>
                              <button
                                type="button"
                                className="dash-btn-ghost"
                                disabled={busy}
                                onClick={() => {
                                  setDoneFor(null);
                                  setDoneNote('');
                                }}
                              >
                                {t.cancel}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {doneFor !== tk.id && (
                        <div className="task-card-actions">
                          <button
                            type="button"
                            className="dash-btn-gold"
                            disabled={busy}
                            onClick={() => {
                              clearRowError(tk.id);
                              setDoneFor(tk.id);
                              setDoneNote('');
                            }}
                          >
                            {t.markDone}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Optional follow-up create form (opened by "Approve & Task"). task-1 is
          already approved by the time this shows; cancelling keeps it approved
          and simply creates no follow-up. Reuses the same create API + fields as
          the file-detail Add-task form (no due date — tasks have no due_date). */}
      {/* Asked AFTER the approval has already been committed. */}
      {followUpAsk && (
        <div
          className="dash-modal-scrim"
          role="dialog"
          aria-modal="true"
          aria-label={ar ? 'مهمة تالية' : 'Follow-up task'}
          onClick={() => setFollowUpAsk(null)}
        >
          <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dash-modal-head">
              <div className="dash-section-header" style={{ margin: 0 }}>
                {ar ? 'تمت الموافقة' : 'Approved'}
              </div>
              <button
                type="button"
                className="dash-modal-close"
                aria-label={t.close}
                onClick={() => setFollowUpAsk(null)}
              >
                ×
              </button>
            </div>
            <p className="dash-subtitle" style={{ margin: '4px 0 14px' }} dir="auto">
              {ar
                ? `تمت الموافقة على "${followUpAsk.title}". هل تريد إنشاء مهمة تالية لنفس الموظف؟`
                : `"${followUpAsk.title}" was approved. Create a follow-up task for the same employee?`}
            </p>
            <div className="dash-modal-actions">
              <button
                type="button"
                className="dash-btn-ghost"
                onClick={() => setFollowUpAsk(null)}
              >
                {ar ? 'لا، شكرًا' : 'No, thanks'}
              </button>
              <button
                type="button"
                className="dash-btn-gold"
                onClick={() => {
                  const tk = followUpAsk;
                  setFollowUpAsk(null);
                  openFollowUp(tk);
                }}
              >
                {ar ? 'إنشاء مهمة تالية' : 'Create follow-up task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {followUp && (
        <div
          className="dash-modal-scrim"
          role="dialog"
          aria-modal="true"
          aria-label={t.followUpTitle}
          onClick={closeFollowUp}
        >
          <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dash-modal-head">
              <div className="file-detail-title">{t.followUpTitle}</div>
              <button
                type="button"
                className="dash-modal-close"
                aria-label={t.cancel}
                onClick={closeFollowUp}
              >
                ×
              </button>
            </div>

            <form
              className="task-form"
              onSubmit={(e) => {
                e.preventDefault();
                void onSubmitFollowUp();
              }}
              noValidate
            >
              <p className="dash-hint" style={{ margin: '0 0 4px' }}>
                {t.followUpHint}
              </p>
              {fuError && (
                <div className="dash-alert dash-alert-error" role="alert">
                  {fuError}
                </div>
              )}

              {/* Folder context (read-only) */}
              <div className="dash-field">
                <label className="dash-eyebrow">{t.navFiles}</label>
                <div className="task-card-meta" style={{ marginTop: 2 }}>
                  <span className="access-req-badge">
                    {lang === 'ar'
                      ? followUp.companyNameAr
                      : followUp.companyNameEn}
                  </span>
                  <span className="task-card-file">{followUp.fileLabel}</span>
                </div>
              </div>

              {/* Responsible — LOCKED to the same employee who finished task-1 */}
              <div className="dash-field">
                <label className="dash-eyebrow">{t.taskAssignee}</label>
                <div className="task-row-who" style={{ marginTop: 4 }}>
                  <span className="access-avatar" aria-hidden="true">
                    {taskInitial(taskPersonName(followUp.assignee, lang))}
                  </span>
                  {taskPersonName(followUp.assignee, lang)}
                </div>
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="fu-title">
                  {t.taskTitleField}
                </label>
                <input
                  id="fu-title"
                  className="dash-input"
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                  value={fuTitle}
                  onChange={(e) => setFuTitle(e.target.value)}
                  placeholder={t.taskTitlePlaceholder}
                  required
                />
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="fu-desc">
                  {t.taskDescriptionField}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <input
                  id="fu-desc"
                  className="dash-input"
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                  value={fuDesc}
                  onChange={(e) => setFuDesc(e.target.value)}
                />
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="fu-assignee">
                  {t.taskAssignee}
                </label>
                <select
                  id="fu-assignee"
                  className="dash-input"
                  value={fuAssignee}
                  onChange={(e) => setFuAssignee(e.target.value)}
                  disabled={fuLoadingPickers}
                  required
                >
                  <option value="">{t.selectAssigneePlaceholder}</option>
                  {fuAssignees.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {taskPersonName(p, lang)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="fu-approver">
                  {t.taskApprover}
                </label>
                <select
                  id="fu-approver"
                  className="dash-input"
                  value={fuApprover}
                  onChange={(e) => setFuApprover(e.target.value)}
                  disabled={fuLoadingPickers}
                  required
                >
                  <option value="">{t.selectApproverPlaceholder}</option>
                  {fuApprovers.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {taskPersonName(p, lang)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="dash-modal-actions">
                <button
                  type="button"
                  className="dash-btn-ghost"
                  onClick={closeFollowUp}
                  disabled={fuSaving}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="dash-btn-green"
                  disabled={fuSaving || !fuTitle.trim() || !fuApprover || !fuAssignee}
                >
                  {fuSaving ? t.creatingTask : t.createTask}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* The day's tasks, read-only. The calendar draws load bars; this is
          how you see WHICH tasks make up a bar. canPlan is false, so the
          drawer renders without the drag, the unschedule, the delete and the
          hours editor a manager gets. */}
      {view === 'calendar' && openDay && (
        <DayTasksDrawer
          dayKey={openDay}
          tasks={tasksOn(myOpenShown, openDay, me?.userId)}
          lang={lang}
          canPlan={false}
          onClose={() => setOpenDay(null)}
          onEdit={() => {}}
          onDelete={() => {}}
          onUnschedule={() => {}}
          onSetHours={() => {}}
          deleteLabel={() => ''}
          deleteBusy={() => false}
          draggingId={null}
          onDragStart={() => {}}
          onDragEnd={() => {}}
        />
      )}

      {openFolderId && (
        <FolderQuickDrawer
          key={openFolderId}
          fileId={openFolderId}
          viewerTasks={[...myOpen, ...awaiting, ...pendingApproval]}
          onClose={() => setOpenFolderId(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
