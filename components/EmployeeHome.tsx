'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDash } from './DashboardShell';
import FolderIcon from './FolderIcon';
import FolderTitle from './FolderTitle';
import AttendanceBanner from './AttendanceBanner';
import FolderQuickDrawer from './FolderQuickDrawer';
import {
  fileClientName,
  fileOpponentName,
  GridGlyph,
  KanbanGlyph,
  ListGlyph,
  type ClientFile,
} from './FilesView';
import { SECTION_START_COLOR, type FileSection } from '@/lib/platform/fileColors';
import type { ClientTaskWithFile } from './taskTypes';

/**
 * Employee "My Files" view. Lists the employee's OWN folders — files where they
 * have an ACTIVE access grant OR an assigned task — split into two labelled
 * sections: "Potential Files" and "Active Files". EXPIRED (green / closed)
 * folders are deliberately NOT shown in either section: My Files is a live work
 * surface, and an expired file has no pending work for the employee.
 *
 * The folder set is SERVER-SCOPED (GET /api/files/mine?company_id=…): filtered
 * to this employee's files and to the ACTIVE company, so no other employee's or
 * company's files can appear. Folder COLOR is the SAME derived value everyone
 * else sees for that folder (aggregate across every employee's open tasks) —
 * matching the admin/manager Folders view. Only the badge count stays
 * per-viewer (just this employee's own unfinished tasks).
 *
 * Tapping a folder opens the SAME drawer an admin or manager gets (see
 * FolderQuickDrawer). What differs is what the server puts in each tab: the
 * Tasks tab falls back to this employee's own tasks, since seeing every task on
 * a folder is its own capability, and the Drive link appears only when the
 * server sent one — i.e. when they hold an active access grant.
 */
/**
 * The folder layouts available here: the three the manager Folders screen
 * offers, plus 'sections' — the stacked Potential-then-Active grids this screen
 * had before there was any choice. It is kept as a view rather than dropped,
 * because it is the layout every employee already knows this page by.
 */
type ViewMode = 'grid' | 'list' | 'kanban' | 'sections';

function isViewMode(v: unknown): v is ViewMode {
  return v === 'grid' || v === 'list' || v === 'kanban' || v === 'sections';
}

/** A stack of labelled bands — the glyph for the 'sections' view. */
const SectionsGlyph = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="7" rx="1.5" />
    <rect x="3" y="14" width="18" height="7" rx="1.5" />
  </svg>
);

/** Per-browser persistence of the My Files layout choice. */
const MY_FILES_VIEW_KEY = 'albaker.myFilesView.v1';

export default function EmployeeHome() {
  const { t, lang, activeCompany } = useDash();
  const companyId = activeCompany?.id;

  const [files, setFiles] = useState<ClientFile[]>([]);
  const [tasks, setTasks] = useState<ClientTaskWithFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  // Which task's "what did you do?" box is open, and its text. Clicking
  // "Mark done" opens the box; the confirm button inside it does the POST.
  const [query, setQuery] = useState('');

  // Which folder layout this employee is using.
  //
  // 'sections' is the DEFAULT — the stacked Potential/Active grids this screen
  // has always had. Adding views should not silently rearrange the page for
  // every employee who never asked for a different one; they now have three
  // more layouts a click away, and the one they know stays where it was.
  //
  // Persisted per browser under its OWN key, separate from the manager Folders
  // screen's: the two offer different views (there is no drag-to-move here),
  // and a shared key would make a choice on one screen change the other.
  const [view, setView] = useState<ViewMode>('sections');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MY_FILES_VIEW_KEY);
      if (isViewMode(saved)) setView(saved);
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);
  const selectView = useCallback((v: ViewMode) => {
    setView(v);
    try {
      window.localStorage.setItem(MY_FILES_VIEW_KEY, v);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  const load = useCallback(async () => {
    if (!companyId) {
      setFiles([]);
      setTasks([]);
      setLoading(false);
      setLoadError(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      // Folders (authoritative, employee-scoped) + the caller's own tasks (for
      // the per-folder drill-down). Both are scoped server-side to the caller.
      const [filesRes, tasksRes] = await Promise.all([
        fetch(`/api/files/mine?company_id=${encodeURIComponent(companyId)}`, {
          cache: 'no-store',
        }),
        fetch('/api/tasks/mine', { cache: 'no-store' }),
      ]);
      const filesData = (await filesRes.json().catch(() => ({}))) as {
        ok?: boolean;
        files?: ClientFile[];
      };
      const tasksData = (await tasksRes.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTaskWithFile[];
      };
      if (!filesRes.ok || !filesData.ok || !Array.isArray(filesData.files)) {
        setLoadError(true);
        setFiles([]);
        setTasks([]);
      } else {
        setFiles(filesData.files);
        // The drill-down tasks are best-effort — tolerate a tasks/mine failure
        // rather than blocking the whole folder list on it.
        setTasks(
          tasksRes.ok && tasksData.ok && Array.isArray(tasksData.tasks)
            ? tasksData.tasks
            : []
        );
      }
    } catch {
      setLoadError(true);
      setFiles([]);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  // Split folders by section. Expired folders are intentionally excluded.
  /**
   * SEARCH, over the folders this employee can see.
   *
   * Covers what a person actually knows a folder by: either side of the title
   * (client and opponent, in BOTH languages, since a folder filed in one may
   * be searched for in the other) and the case number. Substring and
   * case-insensitive, so a partial number like "9911" finds "9911/2026".
   *
   * Deliberately the SAME predicate the manager Folders screen uses: two
   * screens listing the same folders that disagree about what search means is
   * worse than either behaviour alone.
   *
   * Applied to the loaded list, not re-queried — the folders are already in
   * memory, so it costs no round trip and stays instant.
   */
  const matchesQuery = useCallback(
    (f: ClientFile) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [f.clientEn, f.clientAr, f.opponentEn, f.opponentAr, f.caseNumber]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    },
    [query]
  );

  const potential = useMemo(
    () => files.filter((f) => f.section === 'potential' && matchesQuery(f)),
    [files, matchesQuery]
  );
  const active = useMemo(
    () => files.filter((f) => f.section === 'active' && matchesQuery(f)),
    [files, matchesQuery]
  );
  const hasVisible = potential.length > 0 || active.length > 0;
  const searching = query.trim() !== '';

  const selected = useMemo(
    () => files.find((f) => f.id === selectedFileId) ?? null,
    [files, selectedFileId]
  );


  // One folder card — shared by both sections. The Drive link lives in the
  // folder DETAIL panel, not on the card.
  const renderFolderCard = (f: ClientFile) => (
    <button
      key={f.id}
      type="button"
      className="file-folder"
      onClick={() => setSelectedFileId(f.id)}
    >
      <div className="file-folder-icon">
        <FolderIcon color={f.color.hex} />
        {f.openTaskCount > 0 && (
          <span className="file-badge" aria-hidden="true">
            {f.openTaskCount}
          </span>
        )}
      </div>
      {f.color.alertLevel === 'critical' && (
        <span className="file-alert-badge">{t.alertBadge}</span>
      )}
      <div className="file-folder-title">
        <FolderTitle
          client={fileClientName(f, lang)}
          opponent={fileOpponentName(f, lang)}
          folderType={f.folderTypeLayout}
        />
      </div>
      {/* The creation DATE has been removed from the card — see the note in
          FilesView. The case number stays: it is part of what the folder is
          called, not a date. */}
      {f.caseNumber && (
        <div className="file-folder-meta" dir="ltr">
          {f.caseNumber}
        </div>
      )}
    </button>
  );

  const renderSection = (
    label: string,
    section: FileSection,
    list: ClientFile[]
  ) => (
    <section style={{ marginTop: 20 }}>
      <div className="dash-section-header">
        <span
          className="dash-sq"
          style={{ background: SECTION_START_COLOR[section] }}
          aria-hidden="true"
        />
        {label}
        <span className="dash-count">{list.length}</span>
      </div>
      {list.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.noFilesInSection}
          </p>
        </div>
      ) : (
        <div className="files-grid">{list.map(renderFolderCard)}</div>
      )}
    </section>
  );

  /**
   * ALL THE FOLDER VIEWS, for an employee too.
   *
   * This screen used to have exactly one shape: two labelled grids, Potential
   * above Active. Managers had three views to choose from on their own Folders
   * screen and an employee had none — the same folders, in a layout they could
   * not change, with no way to see them as a table or as one flat set.
   *
   * WHAT DOES NOT CHANGE IS WHAT IS IN THEM. Every view here renders the SAME
   * server-scoped list from /api/files/mine — the folders this employee holds a
   * grant to, is assigned a task on, or that are general/pinned — and opening
   * one still shows ONLY their own tasks, from /api/tasks/mine. A view is a
   * layout, never a widening of what may be seen; both endpoints re-enforce
   * that server-side regardless of what this component asks for.
   */
  const renderFolderViews = () => {
    if (view === 'list') {
      return (
        <div className="dash-card" style={{ padding: 0, marginTop: 20 }}>
          <div className="dash-table-wrap">
            <table className="dash-table files-table">
              <thead>
                <tr>
                  <th>{t.fileClient}</th>
                  <th>{t.fileOpponent}</th>
                  <th>{t.fileSection}</th>
                  <th>{t.colTask}</th>
                </tr>
              </thead>
              <tbody>
                {[...potential, ...active].map((f) => (
                  <tr
                    key={f.id}
                    className="files-row"
                    onClick={() => setSelectedFileId(f.id)}
                  >
                    <td>
                      <span className="files-row-client">
                        <span
                          className="files-swatch"
                          style={{ background: f.color.hex }}
                          aria-hidden="true"
                        />
                        {fileClientName(f, lang)}
                        {f.color.alertLevel === 'critical' && (
                          <span className="file-alert-chip">{t.alertBadge}</span>
                        )}
                      </span>
                    </td>
                    <td>{fileOpponentName(f, lang)}</td>
                    <td>
                      <span
                        className="files-chip"
                        style={{
                          background: `${SECTION_START_COLOR[f.section]}22`,
                          color: '#5b564e',
                          border: `1px solid ${SECTION_START_COLOR[f.section]}`,
                        }}
                      >
                        {f.section === 'potential'
                          ? t.sectionPotential
                          : t.sectionActive}
                      </span>
                    </td>
                    {/* The employee's OWN open task count in the folder, which
                        is the number the badge on the card shows too. */}
                    <td className="dash-td-muted">{f.openTaskCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    if (view === 'grid') {
      // One flat set, no section headings — for the employee who knows which
      // folder they want and does not care which pile it is in.
      return (
        <div className="files-grid" style={{ marginTop: 20 }}>
          {[...potential, ...active].map(renderFolderCard)}
        </div>
      );
    }

    // 'kanban' — the two piles as columns rather than stacked grids, so both
    // are on screen at once. Read-only: moving a folder between sections is a
    // manager's act and an employee has no permission for it, so the cards are
    // not draggable here.
    return (
      <div className="files-kanban-board" style={{ marginTop: 20 }}>
        {(
          [
            ['potential', t.sectionPotential, potential],
            ['active', t.sectionActive, active],
          ] as [FileSection, string, ClientFile[]][]
        ).map(([section, label, list]) => (
          <div key={section} className="files-kanban-col">
            <div className="files-kanban-head">
              <span
                className="files-tab-dot"
                style={{ background: SECTION_START_COLOR[section] }}
                aria-hidden="true"
              />
              <span className="files-kanban-head-label">{label}</span>
              <span className="files-tab-count">{list.length}</span>
            </div>
            <div className="files-kanban-list">
              {list.length === 0 ? (
                <div className="files-kanban-empty">{t.noFilesInSection}</div>
              ) : (
                list.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="file-folder-krow"
                    onClick={() => setSelectedFileId(f.id)}
                  >
                    <span className="krow-icon">
                      <FolderIcon color={f.color.hex} size={34} />
                      {f.openTaskCount > 0 && (
                        <span className="file-badge" aria-hidden="true">
                          {f.openTaskCount}
                        </span>
                      )}
                    </span>
                    <span className="krow-title">
                      <FolderTitle
                        client={fileClientName(f, lang)}
                        opponent={fileOpponentName(f, lang)}
                        folderType={f.folderTypeLayout}
                        oneLine
                      />
                    </span>
                    {f.color.alertLevel === 'critical' && (
                      <span
                        className="krow-alert"
                        title={t.alertBadge}
                        aria-label={t.alertBadge}
                      />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.myFilesTitle}</h1>
          <p className="dash-subtitle">{t.myFilesSubtitle}</p>
        </div>
      </div>

      <AttendanceBanner />

      {loading ? (
        <div className="dash-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            …
          </p>
        </div>
      ) : loadError ? (
        <div className="dash-card dash-state-card">
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadFiles}
          </div>
          <button type="button" className="dash-btn-gold" onClick={load}>
            {t.retry}
          </button>
        </div>
      ) : !hasVisible && !searching ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.noMyFiles}
          </p>
        </div>
      ) : (
        <>
          <div className="files-toolbar">
            <input
              className="dash-input files-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.filesSearchPlaceholder}
              aria-label={t.filesSearchPlaceholder}
            />
            <div className="files-view-toggle" role="group" aria-label="view">
              <button
                type="button"
                className={`files-view-btn${view === 'kanban' ? ' is-active' : ''}`}
                aria-pressed={view === 'kanban'}
                aria-label={t.kanbanView}
                title={t.kanbanView}
                onClick={() => selectView('kanban')}
              >
                <KanbanGlyph />
              </button>
              <button
                type="button"
                className={`files-view-btn${view === 'grid' ? ' is-active' : ''}`}
                aria-pressed={view === 'grid'}
                aria-label={t.gridView}
                title={t.gridView}
                onClick={() => selectView('grid')}
              >
                <GridGlyph />
              </button>
              <button
                type="button"
                className={`files-view-btn${view === 'list' ? ' is-active' : ''}`}
                aria-pressed={view === 'list'}
                aria-label={t.listView}
                title={t.listView}
                onClick={() => selectView('list')}
              >
                <ListGlyph />
              </button>
              <button
                type="button"
                className={`files-view-btn${
                  view === 'sections' ? ' is-active' : ''
                }`}
                aria-pressed={view === 'sections'}
                aria-label={t.sectionsView}
                title={t.sectionsView}
                onClick={() => selectView('sections')}
              >
                <SectionsGlyph />
              </button>
            </div>
          </div>
          {/* A search that matched nothing says so, rather than rendering an
              empty grid — and the toolbar above stays put so the query can be
              cleared without hunting for it. Distinguished from "no folders at
              all", which is a different fact about the account. */}
          {!hasVisible && searching ? (
            <div className="dash-card dash-state-card" style={{ marginTop: 20 }}>
              <p className="dash-subtitle" style={{ margin: 0 }}>
                {t.noFilesMatch}
              </p>
            </div>
          ) : view === 'sections' ? (
            <>
              {renderSection(t.myFilesPotential, 'potential', potential)}
              {renderSection(t.myFilesActive, 'active', active)}
            </>
          ) : (
            renderFolderViews()
          )}
        </>
      )}

      {/* THE SAME DRAWER EVERYONE ELSE GETS. It opens over the list rather
          than replacing the page, and it is the same component an admin or a
          manager opens — same tabs, same shape. What differs is what the
          SERVER puts in each tab: the Tasks tab falls back to this employee's
          own tasks, because seeing every task on a folder is its own
          capability. Rendering a different component per role made the same
          folder a different kind of object depending on who looked at it. */}
      {selected && (
        <FolderQuickDrawer
          key={selected.id}
          fileId={selected.id}
          // This list already fetched the folder, access check and all, so the
          // drawer opens synchronously rather than re-fetching what we hold.
          initialFile={selected}
          viewerTasks={tasks}
          onClose={() => setSelectedFileId(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
