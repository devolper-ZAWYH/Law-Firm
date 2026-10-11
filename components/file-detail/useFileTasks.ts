'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ClientTask, TaskPerson } from '../taskTypes';
import type { AssigneeOption } from './types';

/**
 * The folder's tasks and the Add-task pickers, fetched ONCE for the whole
 * drawer.
 *
 * Lifted out of the Tasks tab because the Details tab needs the same data: it
 * warns, in red, about any open task whose assignee is away (leave does not
 * pause the task clock, so somebody has to reassign it). Fetching in both tabs
 * would double every request and let the two disagree.
 */
export interface FileTasksState {
  tasks: ClientTask[];
  assignees: AssigneeOption[];
  approvers: TaskPerson[];
  currentUserId: string;
  /** Whether the server disclosed who assigned each task (manager/admin only). */
  seesAssigner: boolean;
  loading: boolean;
  loadError: boolean;
  /**
   * True when the folder-wide list was REFUSED and these are only the viewer's
   * own tasks. The Tasks tab says so, rather than presenting a partial list as
   * if it were the whole folder.
   */
  ownOnly: boolean;
  reload: () => Promise<void>;
}

export function useFileTasks(
  fileId: string,
  /**
   * The viewer's OWN tasks on this folder, used when the folder-wide list is
   * refused.
   *
   * Seeing every task on a folder is its own capability ('tasks.viewOnFolder'),
   * so a plain employee gets a 404 from that endpoint — correctly. Without a
   * fallback the tab would then show "could not load tasks" on a folder they
   * can plainly see, which reads as breakage rather than as a boundary. Their
   * own tasks are data they already hold, so the tab shows those and labels
   * them.
   */
  ownTasks?: ClientTask[]
): FileTasksState {
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [approvers, setApprovers] = useState<TaskPerson[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [seesAssigner, setSeesAssigner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [ownOnly, setOwnOnly] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/tasks`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tasks?: ClientTask[];
        assignees?: AssigneeOption[];
        approvers?: TaskPerson[];
        currentUserId?: string;
        seesAssigner?: boolean;
      };
      if (!res.ok || !data.ok) {
        // REFUSED, not broken. 403/404 here means "you may not see every task
        // on this folder" — a boundary, and one the viewer's own tasks fill
        // perfectly well. A real failure (500, network) still surfaces.
        const refused = res.status === 403 || res.status === 404;
        if (refused && ownTasks) {
          setTasks(ownTasks);
          setOwnOnly(true);
          setLoadError(false);
        } else {
          setLoadError(true);
          setTasks([]);
          setOwnOnly(false);
        }
        setAssignees([]);
        setApprovers([]);
      } else {
        setOwnOnly(false);
        setTasks(Array.isArray(data.tasks) ? data.tasks : []);
        // onLeaveUntil is absent from an older payload — default it to null so
        // nobody is wrongly shown as away.
        setAssignees(
          Array.isArray(data.assignees)
            ? data.assignees.map((a) => ({ ...a, onLeaveUntil: a.onLeaveUntil ?? null }))
            : []
        );
        setApprovers(Array.isArray(data.approvers) ? data.approvers : []);
        setCurrentUserId(
          typeof data.currentUserId === 'string' ? data.currentUserId : ''
        );
        setSeesAssigner(data.seesAssigner === true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
    // ownTasks is a prop of the caller's render, not a fetch input: including
    // it would re-request the folder on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    tasks,
    assignees,
    approvers,
    currentUserId,
    seesAssigner,
    loading,
    loadError,
    ownOnly,
    reload,
  };
}
