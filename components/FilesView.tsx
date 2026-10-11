'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDash } from './DashboardShell';
import {
  FILE_SECTIONS,
  sectionsVisibleToEmployees,
  SECTION_START_COLOR,
  type FileSection,
} from '@/lib/platform/fileColors';
import type { FileColor } from '@/lib/platform/colorEngine';
import { formatDate } from '@/lib/format';
import FileCreateModal from './FileCreateModal';
import { CASE_LEVELS } from '@/lib/caseLevels';
import type { ClientFolderTypeRecord } from './ManageFolderTypesModal';
import FileDetailDrawer from './file-detail/FileDetailDrawer';
import FolderIcon from './FolderIcon';
import FolderTitle from './FolderTitle';
import { fetchFolderTypes } from './folderTypesCache';

/**
 * Files screen (Phase 2). Active-company scoped: reads the active company from
 * the shell context and lists /api/files for it (the server re-enforces company
 * isolation). Section tabs + grid/list toggle; admins get a "New file" button;
 * clicking a file opens a detail panel with a "Move file" control.
 *
 * File COLOR is DERIVED server-side by the Phase-5 color engine and arrives on
 * each file as `color` — the folder tint, the alert level and the step-bar
 * position. Section TAB dots keep the static section start color (they identify
 * the section, not the file's live status).
 */

/** A folder type's KEY — 'case', 'contract', or a custom admin/manager-added
 * type. What fields it carries is decided by its LAYOUT, not the key itself. */
export type ClientFolderType = string;
/** 'case' → client + opponent; 'contract' → client only (no opponent, no vs). */
export type FolderTypeLayout = 'case' | 'contract';

export interface ClientFile {
  id: string;
  companyId: string;
  /** Folder type key. Legacy payloads without it are treated as 'case'. */
  folderType: ClientFolderType;
  /** The RESOLVED layout for folderType (drives opponent show/hide). */
  folderTypeLayout: FolderTypeLayout;
  /** Legacy client text (the linked contact's display name). */
  client: string;
  opponent: string;
  /** Legacy folder-leader text (the linked member's display name). */
  managingLawyer: string;
  driveLink: string | null;
  section: FileSection;
  createdBy: string;
  createdAt: string;
  /** The linked CRM contact (null for a legacy folder). */
  clientContactId: string | null;
  /** Resolved bilingual client (each already falls back; never empty). */
  clientEn: string;
  clientAr: string;
  /** Raw stored bilingual opponent (either may be ''). */
  opponentEn: string;
  opponentAr: string;
  /** The linked company member (null for a legacy folder). */
  folderLeaderId: string | null;
  /** Resolved bilingual folder leader (each already falls back; never empty). */
  folderLeaderEn: string;
  folderLeaderAr: string;
  /** Case identity (migration #32). '' when unset — never null. */
  caseNumber: string;
  court: string;
  caseLevel: string;
  /** The one company-wide folder every employee can see. */
  isGeneral: boolean;
  /**
   * PINNED: visible to every employee without a grant, and sorted first.
   * Unlike the general folder there may be any number of these.
   */
  isPinned: boolean;
  /** An optional SECOND folder type key, or null. Does not affect the layout. */
  folderType2: string | null;
  openTaskCount: number;
  color: FileColor;
  /** Company color-ladder settings — for the per-task next-color countdown. */
  workingDays: number[];
  daysPerColorStep: number;
}

/** Current-language client name (both resolved fields are pre-filled). */
export function fileClientName(f: ClientFile, lang: 'en' | 'ar'): string {
  return lang === 'ar' ? f.clientAr || f.clientEn : f.clientEn || f.clientAr;
}

/** Current-language opponent, falling back to the other language, then legacy. */
export function fileOpponentName(f: ClientFile, lang: 'en' | 'ar'): string {
  const primary = lang === 'ar' ? f.opponentAr : f.opponentEn;
  const secondary = lang === 'ar' ? f.opponentEn : f.opponentAr;
  return primary || secondary || f.opponent;
}

/** Current-language folder leader (both resolved fields are pre-filled). */
export function fileFolderLeaderName(f: ClientFile, lang: 'en' | 'ar'): string {
  return lang === 'ar'
    ? f.folderLeaderAr || f.folderLeaderEn
    : f.folderLeaderEn || f.folderLeaderAr;
}

type ViewMode = 'grid' | 'list' | 'kanban';

/** Persist the Folders view choice per-browser; defaults to Kanban on first load.
 * Bumped to v3 — 'sidebar' stopped being a selectable view (the split-screen
 * detail panel is now how EVERY view opens a folder, not a view of its own),
 * so a browser with that saved no longer matches and falls back to the default. */
const VIEW_STORAGE_KEY = 'albaker.foldersView.v3';
function isViewMode(v: unknown): v is ViewMode {
  return v === 'grid' || v === 'list' || v === 'kanban';
}

/** The caller's own effective permissions in the active company (baseline
 * role rules already folded in server-side — see /api/companies/[id]/permissions/me). */
interface MyPermissions {
  canCreateFile: boolean;
  canEditFile: boolean;
  canDeleteFile: boolean;
  canMoveFileSection: boolean;
  canCreateTask: boolean;
  canManageFileAccess: boolean;
}

const NO_PERMISSIONS: MyPermissions = {
  canCreateFile: false,
  canEditFile: false,
  canDeleteFile: false,
  canMoveFileSection: false,
  canCreateTask: false,
  canManageFileAccess: false,
};

export default function FilesView() {
  const { t, lang, activeCompany } = useDash();
  const ar = lang === 'ar';

  const companyId = activeCompany?.id;
  const role = activeCompany?.role;
  const isAdmin = role === 'admin';
  /*
    THE COLUMNS THIS PERSON HAS. Expired (closed) and Attrition (client lost)
    are for the manager and the admin; an employee is not shown them at all —
    the server excludes them from the list and refuses them one by one, so
    offering the tabs would only produce two columns that are always empty.

    Read from the same constant the server enforces, so the board and the data
    layer cannot drift apart about which columns exist for whom.
  */
  const sections =
    role === 'admin' || role === 'manager' || activeCompany?.isManager === true
      ? FILE_SECTIONS
      : sectionsVisibleToEmployees();

  const [myPerms, setMyPerms] = useState<MyPermissions>(NO_PERMISSIONS);
  // 'tasks.edit' has no legacy boolean — it only lives in the capability tree
  // (see /api/companies/[id]/permissions/me's `capabilities` array) — so it is
  // tracked separately from the seven legacy MyPermissions flags above.
  const [canEditTaskGrant, setCanEditTaskGrant] = useState(false);
  // 'files.caseDetails' likewise has no legacy boolean.
  const [canCaseDetailsGrant, setCanCaseDetailsGrant] = useState(false);
  useEffect(() => {
    if (!companyId) {
      setMyPerms(NO_PERMISSIONS);
      setCanEditTaskGrant(false);
      setCanCaseDetailsGrant(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/permissions/me`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          permissions?: MyPermissions;
          capabilities?: string[];
        };
        if (!cancelled && res.ok && data.ok && data.permissions) {
          setMyPerms(data.permissions);
          setCanEditTaskGrant(
            Array.isArray(data.capabilities) &&
              data.capabilities.includes('tasks.edit')
          );
          setCanCaseDetailsGrant(
            Array.isArray(data.capabilities) &&
              data.capabilities.includes('files.caseDetails')
          );
        }
      } catch {
        /* keep NO_PERMISSIONS — admin/manager still work via role-based UI below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Baseline role checks stay as a fast client-side default (avoids a flash of
  // "no button" for admin/manager while the fetch above is in flight); an
  // employee's extra grants only ever ADD to these once myPerms loads.
  const canCreateFile = isAdmin || myPerms.canCreateFile;
  const canMove =
    role === 'admin' || role === 'manager' || myPerms.canMoveFileSection;

  const [files, setFiles] = useState<ClientFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activeSection, setActiveSection] = useState<FileSection>('potential');
  // Kanban is the DEFAULT view; a saved choice (below) overrides it after mount.
  const [view, setView] = useState<ViewMode>('kanban');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<ClientFile | null>(null);

  // Drag-to-move (Kanban): the folder id being dragged, the column hovered, and
  // the last move error (shown briefly above the board on a failed/rejected move).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<FileSection | null>(
    null
  );
  const [moveError, setMoveError] = useState<string | null>(null);

  // ── Search + filters ──────────────────────────────────────────────────────
  // Applied to the loaded list rather than re-queried: a company's folders are
  // already in memory, so filtering is instant and costs no round trip.
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  // Fetched for the type dropdown's LABELS — a folder carries its type key, and
  // the key alone ('case') is not what anyone calls it.
  const [folderTypes, setFolderTypes] = useState<ClientFolderTypeRecord[]>([]);
  // Shared cache — see components/folderTypesCache.ts.
  useEffect(() => {
    let cancelled = false;
    fetchFolderTypes()
      .then((types) => {
        if (!cancelled) setFolderTypes(types);
      })
      .catch(() => {
        /* the dropdown falls back to the keys present in the list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the persisted view choice on mount (defaults to Kanban otherwise).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (isViewMode(saved)) setView(saved);
    } catch {
      /* localStorage unavailable — keep the Kanban default */
    }
  }, []);

  const selectView = useCallback((v: ViewMode) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  const load = useCallback(async () => {
    if (!companyId) {
      setFiles([]);
      setLoading(false);
      setLoadError(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/files?company_id=${encodeURIComponent(companyId)}`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        files?: ClientFile[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.files)) {
        setLoadError(true);
        setFiles([]);
      } else {
        setFiles(data.files);
      }
    } catch {
      setLoadError(true);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  // Re-fetch whenever the active company changes.
  useEffect(() => {
    load();
  }, [load]);

  /**
   * One predicate, applied everywhere a folder is counted or shown, so the
   * section tabs can never advertise a number the list below does not contain.
   *
   * SEARCH covers what people actually know a folder by: either side of the
   * title (client and opponent, in both languages) and the case number.
   * Matching is case-insensitive and substring — a partial case number like
   * "9911" finds "9911/2026".
   */
  const matchesFilters = useCallback(
    (f: ClientFile) => {
      // EITHER of the folder's types satisfies the filter. A folder that is both
      // a case and a contract must appear under both, or the second type would
      // be a label that hides the folder from half the searches for it.
      if (
        typeFilter &&
        f.folderType !== typeFilter &&
        f.folderType2 !== typeFilter
      ) {
        return false;
      }
      if (levelFilter && (f.caseLevel || '') !== levelFilter) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [f.clientEn, f.clientAr, f.opponentEn, f.opponentAr, f.caseNumber]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    },
    [query, typeFilter, levelFilter]
  );

  const filtered = useMemo(() => files.filter(matchesFilters), [files, matchesFilters]);
  const filtersActive = query.trim() !== '' || typeFilter !== '' || levelFilter !== '';

  const counts = useMemo(() => {
    const c: Record<FileSection, number> = {
      potential: 0,
      active: 0,
      expired: 0,
      attrition: 0,
    };
    // Counted from the FILTERED list so a tab never says 15 while showing 3.
    for (const f of filtered) c[f.section] += 1;
    return c;
  }, [filtered]);

  const visible = useMemo(
    () => filtered.filter((f) => f.section === activeSection),
    [filtered, activeSection]
  );

  // Kanban columns: files grouped by their stored section.
  const bySection = useMemo(() => {
    const g: Record<FileSection, ClientFile[]> = {
      potential: [],
      active: [],
      expired: [],
      attrition: [],
    };
    for (const f of filtered) g[f.section].push(f);
    return g;
  }, [filtered]);

  // Move a folder to a target section via the existing PATCH (admin/manager only;
  // the server re-enforces the guard). Optimistic: the card jumps columns
  // immediately, then reconciles with the returned row (so the DERIVED color
  // follows the new section's ladder). On failure/403 it snaps back.
  const moveToSection = useCallback(
    async (fileId: string, target: FileSection) => {
      if (!canMove) return;
      const current = files.find((f) => f.id === fileId);
      if (!current || current.section === target) return;
      const prevSection = current.section;

      setMoveError(null);
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, section: target } : f))
      );

      try {
        const res = await fetch(
          `/api/files/${encodeURIComponent(fileId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: target }),
          }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          file?: ClientFile;
        };
        if (!res.ok || !data.ok || !data.file) {
          // Snap back to the original column and surface the error.
          setFiles((prev) =>
            prev.map((f) =>
              f.id === fileId ? { ...f, section: prevSection } : f
            )
          );
          setMoveError(data.error || t.couldNotSaveFile);
          return;
        }
        // Reconcile with the authoritative row (recomputed color/section).
        const moved = data.file;
        setFiles((prev) => prev.map((f) => (f.id === fileId ? moved : f)));
      } catch {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId ? { ...f, section: prevSection } : f
          )
        );
        setMoveError(t.networkError);
      }
    },
    [canMove, files, t]
  );

  const sectionLabel = useCallback(
    (s: FileSection) =>
      s === 'potential'
        ? t.sectionPotential
        : s === 'active'
        ? t.sectionActive
        : s === 'expired'
        ? t.sectionExpired
        : t.sectionAttrition,
    [t]
  );

  function onCreated(file: ClientFile) {
    setFiles((prev) => [file, ...prev]);
    setShowCreate(false);
    setActiveSection(file.section); // jump to where the new file landed
  }

  function onMoved(updated: ClientFile) {
    setFiles((prev) =>
      prev.map((f) => (f.id === updated.id ? updated : f))
    );
    setSelected(updated);
  }

  // Admin deleted a folder: drop it from the visible list and close the panel.
  function onDeleted(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setSelected(null);
  }

  // No company at all (e.g. a manager with no memberships): nothing to scope to.
  if (!activeCompany) {
    return (
      <>
        <h1 className="dash-title">{t.filesTitle}</h1>
        <p className="dash-subtitle">{t.filesSubtitle}</p>
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {t.selectCompanyFirst}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.filesTitle}</h1>
          <p className="dash-subtitle">{t.filesSubtitle}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canCreateFile && (
            <button
              type="button"
              className="dash-btn-gold"
              onClick={() => setShowCreate(true)}
            >
              + {t.newFile}
            </button>
          )}
        </div>
      </div>

      {/* Search + filters. Applied to the loaded list, so they narrow every
          view — grid, list and kanban — and the section counts with them. */}
      <div className="files-filterbar">
        <input
          className="dash-input files-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.filesSearchPlaceholder}
          aria-label={t.filesSearchPlaceholder}
        />
        <select
          className="dash-input files-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label={t.filterByType}
        >
          <option value="">{t.filterAllTypes}</option>
          {folderTypes.map((ft) => (
            <option key={ft.key} value={ft.key}>
              {lang === 'ar' ? ft.labelAr : ft.labelEn}
            </option>
          ))}
        </select>
        <select
          className="dash-input files-filter"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          aria-label={t.filterByLevel}
        >
          <option value="">{t.filterAllLevels}</option>
          {CASE_LEVELS.map((level) => (
            <option key={level.key} value={level.key}>
              {lang === 'ar' ? level.ar : level.en}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            className="dash-btn-ghost"
            onClick={() => {
              setQuery('');
              setTypeFilter('');
              setLevelFilter('');
            }}
          >
            {t.clearFilters}
          </button>
        )}
      </div>

      {/* Section tabs + view toggle. In Kanban the sections ARE the columns, so
          the filter tabs are hidden to avoid a redundant control. */}
      <div className="files-toolbar">
        {view === 'kanban' ? (
          <div />
        ) : (
          <div className="files-tabs" role="tablist" aria-label={t.filesTitle}>
            {sections.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={activeSection === s}
                className={`files-tab${
                  activeSection === s ? ' is-active' : ''
                }`}
                onClick={() => setActiveSection(s)}
              >
                <span
                  className="files-tab-dot"
                  style={{ background: SECTION_START_COLOR[s] }}
                  aria-hidden="true"
                />
                <span>{sectionLabel(s)}</span>
                <span className="files-tab-count">{counts[s]}</span>
              </button>
            ))}
          </div>
        )}

        <div className="files-view-toggle" role="group" aria-label="view">
          <button
            type="button"
            className={`files-view-btn${
              view === 'kanban' ? ' is-active' : ''
            }`}
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
        </div>
      </div>

      {/* Body. Wrapped in an IIFE so the view-specific content (kanban board /
          grid / table) can be reused both full-width (nothing selected) and
          as the left pane of the split layout (a folder is selected) without
          duplicating the ternary chain below. */}
      {(() => {
        const content = loading ? (
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
      ) : view === 'kanban' ? (
        <>
          {moveError && (
            <div
              className="dash-alert dash-alert-error files-kanban-error"
              role="alert"
            >
              {moveError}
            </div>
          )}
          <div className="files-kanban-board">
            {sections.map((s) => (
              <div
                key={s}
                className={`files-kanban-col${
                  dragOverSection === s ? ' is-drop' : ''
                }`}
                onDragOver={
                  canMove
                    ? (e) => {
                        e.preventDefault();
                        if (dragOverSection !== s) setDragOverSection(s);
                      }
                    : undefined
                }
                onDragLeave={
                  canMove
                    ? () =>
                        setDragOverSection((cur) => (cur === s ? null : cur))
                    : undefined
                }
                onDrop={
                  canMove
                    ? (e) => {
                        e.preventDefault();
                        setDragOverSection(null);
                        setDraggingId(null);
                        const id =
                          e.dataTransfer.getData('text/plain') || draggingId;
                        if (id) moveToSection(id, s);
                      }
                    : undefined
                }
              >
                <div className="files-kanban-head">
                  <span
                    className="files-tab-dot"
                    style={{ background: SECTION_START_COLOR[s] }}
                    aria-hidden="true"
                  />
                  <span className="files-kanban-head-label">
                    {sectionLabel(s)}
                  </span>
                  <span className="files-tab-count">{counts[s]}</span>
                </div>
                <div className="files-kanban-list">
                  {bySection[s].length === 0 ? (
                    <div className="files-kanban-empty">
                      {filtersActive ? t.noFilesMatch : t.noFilesInSection}
                    </div>
                  ) : (
                    bySection[s].map((f) => (
                      // Compact list-style row: small colored folder glyph at the
                      // inline-start, the client / vs / opponent title as the
                      // focus (vertically centered), and a red alert dot at the
                      // inline-end for critical folders. The DATE and the Drive
                      // link live in the folder DETAIL, not on this card. The
                      // whole row is the drag handle.
                      <button
                        key={f.id}
                        type="button"
                        className={`file-folder-krow${
                          draggingId === f.id ? ' is-dragging' : ''
                        }`}
                        draggable={canMove}
                        onDragStart={
                          canMove
                            ? (e) => {
                                e.dataTransfer.setData('text/plain', f.id);
                                e.dataTransfer.effectAllowed = 'move';
                                setDraggingId(f.id);
                              }
                            : undefined
                        }
                        onDragEnd={
                          canMove
                            ? () => {
                                setDraggingId(null);
                                setDragOverSection(null);
                              }
                            : undefined
                        }
                        onClick={() => setSelected(f)}
                      >
                        <span className="krow-icon">
                          <FolderIcon color={f.color.hex} size={34} />
                          {f.openTaskCount > 0 && (
                            <span className="file-badge" aria-hidden="true">
                              {f.openTaskCount}
                            </span>
                          )}
                        </span>
                        {f.isPinned && (
                          <span
                            className="krow-pin"
                            title={t.pinnedFolderBadge}
                            aria-label={t.pinnedFolderBadge}
                          >
                            <PinGlyph />
                          </span>
                        )}
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
        </>
      ) : visible.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {filtersActive ? t.noFilesMatch : t.noFilesInSection}
          </p>
        </div>
      ) : view === 'grid' ? (
        <div className="files-grid">
          {visible.map((f) => (
            // The Drive link lives in the folder DETAIL panel, not on the card.
            <button
              key={f.id}
              type="button"
              className={`file-folder${f.isPinned ? ' is-pinned' : ''}`}
              onClick={() => setSelected(f)}
            >
              {/* A pinned folder is sorted to the front of the grid, which on
                  its own is invisible — nothing distinguishes "first" from
                  "happens to be newest". The pin says why it is there. */}
              {f.isPinned && (
                <span
                  className="file-pin"
                  title={t.pinnedFolderBadge}
                  aria-label={t.pinnedFolderBadge}
                >
                  <PinGlyph />
                </span>
              )}
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
              {/* THE CARD CARRIES THE NAME, AND THE CASE NUMBER WHEN THERE IS
                  ONE. The creation DATE has been removed: it was on every card
                  in the grid, it is the same for whole runs of folders created
                  in one sitting, and it answers a question nobody asks while
                  scanning for a matter — so it was pure noise under every
                  title, competing with the one line that identifies the folder.
                  It is still on the folder's own detail (and in the list view's
                  Created column, where a sortable date column is the point).

                  The case number stays: it is not a date but part of how the
                  folder is named — "9911/2026" is what the matter is called in
                  court, and it is what people search for. */}
              {f.caseNumber && (
                <div className="file-folder-meta" dir="ltr">
                  {f.caseNumber}
                </div>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="dash-card" style={{ padding: 0 }}>
          <div className="dash-table-wrap">
            <table className="dash-table files-table">
              <thead>
                <tr>
                  <th>{t.fileClient}</th>
                  <th>{t.fileOpponent}</th>
                  <th>{t.fileManagingLawyer}</th>
                  <th>{t.fileCreated}</th>
                  <th>{t.fileSection}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((f) => (
                  <tr
                    key={f.id}
                    className="files-row"
                    onClick={() => setSelected(f)}
                  >
                    <td>
                      <span className="files-row-client">
                        <span
                          className="files-swatch"
                          style={{ background: f.color.hex }}
                          aria-hidden="true"
                        />
                        {f.isPinned && (
                          <span
                            className="files-row-pin"
                            title={t.pinnedFolderBadge}
                            aria-label={t.pinnedFolderBadge}
                          >
                            <PinGlyph />
                          </span>
                        )}
                        {fileClientName(f, lang)}
                        {f.color.alertLevel === 'critical' && (
                          <span className="file-alert-chip">
                            {t.alertBadge}
                          </span>
                        )}
                      </span>
                    </td>
                    <td>{fileOpponentName(f, lang)}</td>
                    <td className="dash-td-muted">
                      {fileFolderLeaderName(f, lang)}
                    </td>
                    <td className="dash-td-muted" dir="auto">
                      {formatDate(f.createdAt, lang)}
                    </td>
                    <td>
                      <span
                        className="files-chip"
                        style={{
                          background: `${SECTION_START_COLOR[f.section]}22`,
                          color: '#5b564e',
                          border: `1px solid ${SECTION_START_COLOR[f.section]}`,
                        }}
                      >
                        {sectionLabel(f.section)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

        // The view ALWAYS keeps its full width — opening a folder no longer
        // narrows the board. The folder's detail opens OVER the page instead,
        // in a drawer pinned to the inline-end edge (right in English, left in
        // Arabic) above a dimming veil.
        //
        // THE VEIL DOES NOT TAKE CLICKS (pointer-events: none — see the CSS).
        // It used to be a full-viewport scrim that swallowed them, so with a
        // folder open, clicking a DIFFERENT folder card hit the scrim instead
        // of the card: the drawer closed and nothing opened, and you had to
        // click the same card twice to read it. Comparing two folders — the
        // single most common thing done on this screen — cost double the
        // clicks and looked like the card was broken.
        //
        // Clicking a card now switches the drawer straight to that folder.
        // Dismissing by clicking away is unchanged: the drawer closes itself on
        // an outside pointer-down (see FileDetailDrawer), which covers the
        // empty page around the cards as well as the veil itself.
        return (
          <>
            {content}
            {selected && (
              <>
                <div className="folder-drawer-scrim" aria-hidden="true" />
                <FileDetailDrawer
                  key={selected.id}
                  file={selected}
                  canMove={canMove}
                  canManageAccess={
                    role === 'admin' ||
                    role === 'manager' ||
                    myPerms.canManageFileAccess
                  }
                  canCreateTask={
                    isAdmin ||
                    activeCompany?.isManager === true ||
                    myPerms.canCreateTask
                  }
                  canEditTask={
                    isAdmin ||
                    role === 'manager' ||
                    canEditTaskGrant
                  }
                  canPushBack={role === 'admin' || role === 'manager'}
                  // Admin/manager by ROLE. An employee holding the 'tasks.delete'
                  // grant is not offered the button here — the grant may carry
                  // an approval requirement, and the folder drawer is not where
                  // that conversation belongs; the server still honours it for
                  // anyone who posts the request directly.
                  canDeleteTask={role === 'admin' || role === 'manager'}
                  canEditCore={isAdmin || myPerms.canEditFile}
                  // Wider than canEditCore on purpose: any MANAGER may record
                  // a case number without also being able to rewrite the
                  // client. Mirrors canEditCaseDetails on the server.
                  canEditCaseDetails={
                    isAdmin ||
                    role === 'manager' ||
                    myPerms.canEditFile ||
                    canCaseDetailsGrant
                  }
                  canDeleteFile={isAdmin || myPerms.canDeleteFile}
                  onClose={() => setSelected(null)}
                  onMoved={onMoved}
                  onTasksChanged={load}
                  onDeleted={onDeleted}
                />
              </>
            )}
          </>
        );
      })()}

      {showCreate && companyId && (
        <FileCreateModal
          companyId={companyId}
          onClose={() => setShowCreate(false)}
          onCreated={onCreated}
        />
      )}
    </>
  );
}

/** A pushpin, for a folder pinned to the front of the list. */
const PinGlyph = () => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <path d="M12 14v6" />
  </svg>
);

// ---- tiny inline glyphs for the view toggle ----
export const KanbanGlyph = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    aria-hidden="true"
  >
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="9.5" y="4" width="5" height="11" rx="1.5" />
    <rect x="16" y="4" width="5" height="14" rx="1.5" />
  </svg>
);
export const GridGlyph = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    aria-hidden="true"
  >
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
  </svg>
);
export const ListGlyph = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
