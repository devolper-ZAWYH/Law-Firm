'use client';

import { useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import FileDetailDrawer from './file-detail/FileDetailDrawer';
import FolderIcon from './FolderIcon';
import FolderTitle from './FolderTitle';
import type { ClientFile } from './FilesView';
import type { ClientTaskWithFile } from './taskTypes';

/**
 * OPEN A FOLDER FROM SOMEWHERE THAT ONLY KNOWS ITS ID.
 *
 * My Tasks lists tasks, and a task carries a BRIEF of its folder — an id, the
 * two names, a colour — not the folder itself. Both drawers need the whole
 * record (section, type layout, case details, the permissions that hang off
 * it), so this fetches it on demand and shows the drawer when it arrives.
 *
 * Fetching rather than passing it down is also the access check: GET
 * /api/files/:id answers 404 for a folder the caller may not see, so a task
 * row cannot become a way to read a folder the server would otherwise refuse.
 *
 * ONE DRAWER FOR EVERYONE. A folder opens the same way whoever opens it —
 * same tabs, same shape — and the CONTENT of each tab is decided by the
 * server, not by rendering a different component per role. An employee sees
 * the details, the summary, the documents and the comments they are already
 * entitled to; the Tasks tab falls back to their own tasks, because seeing
 * every task on a folder is its own capability (see useFileTasks).
 *
 * The permission props below only decide which CONTROLS are drawn. Every one
 * of them is re-checked server-side, so a wrong guess here costs a button that
 * returns 403, never access.
 */
export default function FolderQuickDrawer({
  fileId,
  viewerTasks,
  initialFile,
  onClose,
  onChanged,
}: {
  fileId: string;
  /** The viewer's own tasks — the Tasks tab's fallback (see useFileTasks). */
  viewerTasks: ClientTaskWithFile[];
  /**
   * The folder, when the CALLER already has it.
   *
   * A list that rendered the card has the whole record and has already been
   * through the server's access check to get it. Re-fetching it costs a round
   * trip during which nothing at all was drawn — on a distant database that is
   * most of a second of a drawer that looks broken. Given it, the drawer opens
   * synchronously and never fetches.
   *
   * Omit it where the caller genuinely has only an id (My Tasks holds a task's
   * BRIEF of its folder, not the folder), and the header below is drawn from
   * the brief while the record loads.
   */
  initialFile?: ClientFile;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, activeCompany } = useDash();
  const role = activeCompany?.role;
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';
  const privileged = isAdmin || isManager;

  const [file, setFile] = useState<ClientFile | null>(initialFile ?? null);
  const [failed, setFailed] = useState(false);

  // The caller's own permissions in this company. Fetched for EVERY role, not
  // just managers: an employee may hold granted permissions (create a task,
  // edit the folder) and the drawer must offer those controls to them too.
  const [perms, setPerms] = useState<{
    canEditFile: boolean;
    canDeleteFile: boolean;
    canMoveFileSection: boolean;
    canCreateTask: boolean;
    canManageFileAccess: boolean;
  } | null>(null);

  useEffect(() => {
    // Already have it — the caller's list fetched it, access check included.
    if (initialFile) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
          cache: 'no-store',
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          file?: ClientFile;
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !data.file) setFailed(true);
        else setFile(data.file);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, initialFile]);

  useEffect(() => {
    if (!activeCompany?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(activeCompany.id)}/permissions/me`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          permissions?: typeof perms;
        };
        if (!cancelled && res.ok && data.ok && data.permissions) {
          setPerms(data.permissions);
        }
      } catch {
        /* role-based defaults below still apply */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCompany?.id]);

  // A folder that could not be loaded closes rather than showing an empty
  // drawer: the only reasons are "no longer there" and "not yours", and
  // neither has anything to put in a panel.
  useEffect(() => {
    if (failed) onClose();
  }, [failed, onClose]);

  if (!file) {
    /**
     * THE SHELL, DRAWN IMMEDIATELY.
     *
     * Returning null here meant a click on a task's folder did nothing visible
     * until the record arrived — on this database roughly 900ms of a screen
     * that had not acknowledged the click at all, which reads as a dead
     * control and gets clicked again.
     *
     * The task's own brief carries the folder's two names and its colour, so
     * the header is real, not a grey box. Only the tab contents are pending.
     */
    const brief = viewerTasks.find((tk) => tk.fileId === fileId)?.file;
    return (
      <>
        <div className="folder-drawer-scrim" aria-hidden="true" />
        <aside
          className="dash-modal folder-drawer"
          role="dialog"
          aria-modal="false"
          aria-busy="true"
        >
          <div className="dash-modal-head">
            <div className="file-detail-head">
              {brief?.color && (
                <FolderIcon color={brief.color.hex} size={40} />
              )}
              <div className="file-detail-title" dir="auto">
                {brief ? (
                  <FolderTitle
                    client={brief.client}
                    opponent={brief.opponent}
                    folderType={brief.opponent ? 'case' : 'contract'}
                    oneLine
                  />
                ) : (
                  '…'
                )}
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
          </div>
          <p className="dash-hint" style={{ margin: 0 }}>
            …
          </p>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className="folder-drawer-scrim" aria-hidden="true" />
      <FileDetailDrawer
        file={file}
        canMove={privileged || perms?.canMoveFileSection === true}
        canManageAccess={privileged || perms?.canManageFileAccess === true}
        canCreateTask={privileged || perms?.canCreateTask === true}
        canEditTask={privileged}
        canPushBack={privileged}
        canDeleteTask={privileged}
        canEditCore={isAdmin || perms?.canEditFile === true}
        canEditCaseDetails={isAdmin || isManager || perms?.canEditFile === true}
        canDeleteFile={isAdmin || perms?.canDeleteFile === true}
        onClose={onClose}
        // Nothing here re-lists folders, so a move or a delete simply refreshes
        // the task list and closes.
        onMoved={() => onChanged()}
        onTasksChanged={onChanged}
        ownTasks={viewerTasks.filter((tk) => tk.fileId === file.id)}
        onDeleted={() => {
          onChanged();
          onClose();
        }}
      />
    </>
  );
}
