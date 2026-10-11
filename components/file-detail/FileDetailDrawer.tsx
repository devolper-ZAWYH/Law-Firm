'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDash } from '../DashboardShell';
import { fileClientName, fileOpponentName } from '../FilesView';
import FolderIcon from '../FolderIcon';
import FolderTitle from '../FolderTitle';
import GoogleDriveIcon from '../GoogleDriveIcon';
import DetailsTab from './DetailsTab';
import TasksTab from './TasksTab';
import SummaryTab from './SummaryTab';
import DocumentsTab from './DocumentsTab';
import CommentsTab from './CommentsTab';
import { useFileTasks } from './useFileTasks';
import type { FileDetailProps } from './types';
import type { ClientTask } from '../taskTypes';

/**
 * The folder detail, as a DRAWER over the Folders page, pinned to the
 * inline-end edge — the right in English, the left in Arabic.
 *
 * Replaces the old 2100-line one-scroll panel: the header carries what
 * identifies the folder, and three tabs each carry one job, so opening a folder
 * lands you on what you came for instead of six stacked blocks.
 *
 * The scrim (rendered by FilesView) and Esc both close it; so does the ×.
 */
type Tab = 'details' | 'tasks' | 'summary' | 'documents' | 'comments';

const TABS: { key: Tab; en: string; ar: string }[] = [
  { key: 'details', en: 'Details', ar: 'التفاصيل' },
  { key: 'tasks', en: 'Tasks', ar: 'المهام' },
  // The standing description of the matter sits BEFORE the comment log: it is
  // what someone opening the folder cold needs first.
  { key: 'summary', en: 'File summary', ar: 'ملخص الملف' },
  { key: 'documents', en: 'Documents', ar: 'المستندات' },
  { key: 'comments', en: 'Comments', ar: 'التعليقات' },
];

export default function FileDetailDrawer(
  props: FileDetailProps & {
    /**
     * The viewer's OWN tasks on this folder. Used only when the folder-wide
     * list is refused — seeing every task on a folder is its own capability,
     * so a plain employee gets their own instead of an error. See useFileTasks.
     */
    ownTasks?: ClientTask[];
  }
) {
  const { file, onClose } = props;
  const { t, lang } = useDash();
  const [tab, setTab] = useState<Tab>('details');
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [hasSummary, setHasSummary] = useState<boolean | null>(null);
  // null when the count is not meaningful — no Drive folder linked, or Drive
  // could not be read. Only a real listing gets a number.
  const [docCount, setDocCount] = useState<number | null>(null);

  // Fetched ONCE here, not per tab: the Tasks tab lists them and the Details tab
  // needs the same rows to warn about an assignee who is away.
  const tasksState = useFileTasks(file.id, props.ownTasks);

  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Click away to dismiss.
   *
   * This used to be a full-viewport scrim behind the drawer. That scrim also
   * swallowed every click meant for the page, so clicking a different folder
   * card merely closed the drawer and never opened the card — see the note in
   * FilesView. The veil no longer takes clicks, so the dismissal lives here
   * instead, where it can ignore clicks that land on the drawer itself.
   *
   * POINTERDOWN, not click: a click fires on the element the press ENDED over,
   * so selecting text inside the drawer and releasing outside it would close
   * the drawer mid-selection.
   *
   * The modals this drawer opens (edit a task, confirm a deletion) render into
   * the same subtree, so a press inside one of them is `contains`-ed by the
   * drawer and correctly leaves it open.
   */
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = e.target;
      if (target instanceof Node && !panel.contains(target)) onClose();
    };
    // Deferred to the next frame: the very press that OPENED the drawer is
    // still propagating when this effect runs, and would otherwise be seen as
    // an outside click that closes it again immediately.
    const id = window.setTimeout(
      () => document.addEventListener('pointerdown', onPointerDown),
      0
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const onCommentCount = useCallback((n: number) => setCommentCount(n), []);
  const onHasSummary = useCallback((has: boolean) => setHasSummary(has), []);
  const onDocCount = useCallback((n: number | null) => setDocCount(n), []);

  const fileColorHex = file.color.hex;

  function tabLabel(tb: { key: Tab; en: string; ar: string }): string {
    const base = lang === 'ar' ? tb.ar : tb.en;
    if (tb.key === 'tasks' && !tasksState.loading) {
      return `${base} (${tasksState.tasks.length})`;
    }
    if (tb.key === 'comments' && commentCount !== null) {
      return `${base} (${commentCount})`;
    }
    // A dot rather than a count: there is only ever one summary, so the useful
    // signal is simply whether the folder has been described at all.
    if (tb.key === 'summary' && hasSummary === true) {
      return `${base} •`;
    }
    if (tb.key === 'documents' && docCount !== null) {
      return `${base} (${docCount})`;
    }
    return base;
  }

  return (
    <aside
      ref={panelRef}
      className="dash-modal folder-drawer"
      role="dialog"
      // NOT aria-modal. The page behind it stays live and clickable on purpose
      // — clicking another folder card switches the drawer to that folder —
      // and claiming modality would tell a screen reader the rest of the page
      // is inert when it is not.
      aria-modal="false"
      aria-label={t.fileDetailTitle}
    >
      <div
        className="dash-modal-head"
        // Reserve the physical LEFT corner for the Drive icon so the header
        // content (folder glyph/title in LTR, close × in RTL) never sits under
        // it. Physical padding-left → same reserved corner in both directions.
        style={file.driveLink ? { paddingLeft: 44 } : undefined}
      >
        <div className="file-detail-head">
          <FolderIcon color={fileColorHex} size={40} />
          {/* ONE LINE: "client vs opponent" side by side, truncating rather than
              stacking into three lines. The short id that used to sit beneath it
              is gone — it identified nothing a person here needs. */}
          <div className="file-detail-title" dir="auto">
            <FolderTitle
              client={fileClientName(file, lang)}
              opponent={fileOpponentName(file, lang)}
              folderType={file.folderTypeLayout}
              oneLine
            />
          </div>
        </div>
        <button
          type="button"
          className="dash-modal-close"
          aria-label={t.close}
          onClick={onClose}
        >
          ×
        </button>
        {/* Drive icon pinned to the physical TOP-LEFT corner of the drawer —
            same visual corner in AR and EN (physical `left`), opposite the
            title. Only present when the server sent driveLink (admin / manager
            / granted employee). */}
        {file.driveLink && (
          <a
            className="drive-link-corner"
            href={file.driveLink}
            target="_blank"
            rel="noopener noreferrer"
            title={t.openInDrive}
            aria-label={t.openInDrive}
          >
            <GoogleDriveIcon size={24} />
          </a>
        )}
      </div>

      <div className="fd-tabs" role="tablist">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={tab === tb.key}
            className={`fd-tab${tab === tb.key ? ' is-active' : ''}`}
            onClick={() => setTab(tb.key)}
          >
            {tabLabel(tb)}
          </button>
        ))}
      </div>

      {/*
        EVERY TAB IS MOUNTED, and the inactive ones are hidden rather than
        thrown away.

        These used to be `{tab === 'x' && <XTab/>}`. That unmounts the tab you
        leave and remounts it when you come back, and each of these components
        fetches on mount — so every single tab click paid a fresh round trip to
        a database on another continent (600–1500ms measured) and showed a
        spinner, including tabs you had already looked at.

        Mounting them together costs nothing at the wall clock: the requests go
        out in PARALLEL as the drawer opens, so the drawer is ready no later
        than its slowest tab was before, and every tab after that is instant.
        It also fixes the counts in the tab labels, which previously only
        appeared once you had visited the tab they were counting.

        `hidden` rather than `display: none` in a class: it keeps the inactive
        panels out of the accessibility tree and out of tab order, so a
        keyboard user does not walk into the fields of a panel they cannot see.
        None of these components polls or writes on mount, and their form ids
        do not collide, which is what makes this safe.
      */}
      <div hidden={tab !== 'details'}>
        <DetailsTab
          file={file}
          canMove={props.canMove}
          canManageAccess={props.canManageAccess}
          canEditCore={props.canEditCore}
          canEditCaseDetails={props.canEditCaseDetails}
          canDeleteFile={props.canDeleteFile}
          onMoved={props.onMoved}
          onTasksChanged={props.onTasksChanged}
          onDeleted={props.onDeleted}
          tasksState={tasksState}
        />
      </div>
      <div hidden={tab !== 'tasks'}>
        <TasksTab
          file={file}
          canCreateTask={props.canCreateTask}
          canEditTask={props.canEditTask}
          canPushBack={props.canPushBack}
          canDeleteTask={props.canDeleteTask}
          onTasksChanged={props.onTasksChanged}
          tasksState={tasksState}
        />
      </div>
      <div hidden={tab !== 'summary'}>
        <SummaryTab file={file} onHasSummaryChange={onHasSummary} />
      </div>
      <div hidden={tab !== 'documents'}>
        <DocumentsTab file={file} onCountChange={onDocCount} />
      </div>
      <div hidden={tab !== 'comments'}>
        <CommentsTab file={file} onCountChange={onCommentCount} />
      </div>
    </aside>
  );
}
