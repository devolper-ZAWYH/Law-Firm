import type { Strings } from '@/lib/i18n';
import type { FileStatusColorName } from '@/lib/platform/fileColors';
import type { ClientFile } from '../FilesView';
import type { TaskPerson } from '../taskTypes';

/**
 * Shared shapes and tiny helpers for the folder-detail drawer's three tabs.
 *
 * These mirror the JSON the folder APIs return. They lived inline in the old
 * 2100-line FileDetailModal; splitting the panel into tabs meant more than one
 * file needs them, so they moved here rather than being duplicated.
 */

export interface AccessPerson {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
}

export interface PendingItem {
  id: string;
  employee: AccessPerson;
  requestedBy: AccessPerson;
  createdAt: string;
}

/** A comment as returned by GET/POST /api/files/[id]/comments. */
export interface FileCommentDTO {
  id: string;
  authorId: string;
  authorNameEn: string | null;
  authorNameAr: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

/** A CRM contact as returned by GET /api/companies/[id]/contacts. */
export interface CrmContact {
  id: string;
  name: string;
  nameEn: string;
  nameAr: string;
}

/** A company member as returned by GET /api/companies/[id]/employees. */
export interface CompanyMember {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string;
}

/**
 * An assignee candidate. `onLeaveUntil` is the last day of any leave they are on
 * RIGHT NOW — non-null means they may not be given work, and the picker shows
 * them in red and refuses the selection. The server refuses it too (see
 * createTask in lib/platform/tasks.ts); this is the visible half of that rule.
 */
export interface AssigneeOption extends TaskPerson {
  onLeaveUntil: string | null;
}

/** Everything the drawer needs, and passes down to the tabs that use it. */
export interface FileDetailProps {
  file: ClientFile;
  canMove: boolean;
  canManageAccess: boolean;
  /** Whether the caller holds a manager membership → may create tasks here. */
  canCreateTask: boolean;
  /** Baseline admin/manager, extendable via the 'tasks.edit' capability grant
   * (no legacy boolean — see lib/platform/capabilityGrants.ts): edit a
   * not-yet-completed task's title/description/assignee/approver. */
  canEditTask: boolean;
  /**
   * Manager or admin of the folder's company: may rewind a task's colour a step
   * (see pushBackTask). Deliberately NOT a grantable capability — it reverses
   * the very signal the colour ladder exists to raise.
   */
  canPushBack: boolean;
  /**
   * Manager or admin of the folder's company: may DELETE a task that has
   * already been assigned, at any status.
   *
   * Deliberately separate from canEditTask, and wider in one direction while
   * narrower in the other. Editing stops at completion — the server locks an
   * approved task — but deleting does not, because the case for removing a task
   * that should never have been raised usually only becomes clear after it has
   * been signed off. And unlike editing it is not extended by the 'tasks.edit'
   * grant: an employee allowed to retitle a task is not thereby allowed to
   * erase its history. ('tasks.delete' is its own grant, checked server-side.)
   */
  canDeleteTask: boolean;
  /** Baseline admin-only, extendable via can_edit_file: edit the file's core info. */
  canEditCore: boolean;
  /**
   * May set case number / court / level. WIDER than canEditCore: any manager
   * has it, because recording a case number is clerical while changing the
   * client rewrites what the matter is.
   */
  canEditCaseDetails: boolean;
  /** Baseline admin-only, extendable via can_delete_file: permanently delete it. */
  canDeleteFile: boolean;
  onClose: () => void;
  onMoved: (file: ClientFile) => void;
  /** Called after a task is created so the parent can refresh badge counts. */
  onTasksChanged: () => void;
  /**
   * Called after the folder is permanently deleted so the parent can drop it
   * from the list and close the drawer.
   */
  onDeleted: (id: string) => void;
}

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

/** The localized display name of a status color. */
export function colorName(key: FileStatusColorName, t: Strings): string {
  switch (key) {
    case 'lgray':
      return t.colorLgray;
    case 'dgray':
      return t.colorDgray;
    case 'yellow':
      return t.colorYellow;
    case 'orange':
      return t.colorOrange;
    case 'red':
      return t.colorRed;
    case 'green':
      return t.colorGreen;
    default:
      return key;
  }
}
