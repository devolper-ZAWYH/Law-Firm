// Client-side task shapes + tiny pure helpers, shared by the Phase-4 task views.
//
// CLIENT-SAFE: no `server-only`, no I/O. These mirror the JSON the task API
// routes return (lib/platform/tasks.ts). Keep them structurally in sync.

import type { Lang, Strings } from '@/lib/i18n';
import type { FileSection } from '@/lib/platform/fileColors';
import type { FileColor } from '@/lib/platform/colorEngine';
import { formatDate } from '@/lib/format';

export type TaskStatus = 'open' | 'awaiting_approval' | 'approved';
export type TaskEventType =
  | 'created'
  | 'marked_done'
  | 'approved'
  | 'sent_back'
  | 'reassigned';

export interface TaskPerson {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
}

export interface TaskEvent {
  id: string;
  type: TaskEventType;
  actor: TaskPerson | null;
  note: string | null;
  createdAt: string;
}

export interface ClientTask {
  id: string;
  fileId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: TaskPerson | null;
  approver: TaskPerson | null;
  createdBy: TaskPerson | null;
  assignedAt: string;
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
  createdAt: string;
  lastSendBackNote: string | null;
  /** The assignee's completion comment from the latest 'marked_done' event. */
  lastDoneNote: string | null;
  /** When the work is due (migration #32); null when it has no deadline. */
  dueAt: string | null;
  /** Repeat interval in days, or null for a one-off task. */
  repeatEveryDays: number | null;
  /** True when this task must not drive its folder's colour. */
  excludedFromColor: boolean;
  /**
   * Expected effort in hours (migration #33), or null when nobody estimated it.
   * A task with no estimate adds nothing to a day's load bar.
   */
  estimatedHours: number | null;
  /**
   * The day the work is PLANNED for, as 'YYYY-MM-DD' — not when it is DUE
   * (`dueAt`). null means UNSCHEDULED: it sits in the calendar's unscheduled
   * pile until someone drops it onto a day.
   */
  scheduledDate: string | null;
  events?: TaskEvent[];
}

/**
 * A person who can hold work, plus the daily capacity their load bar is drawn
 * against. Mirrors the `people` array from /api/tasks/employee-overview.
 */
export interface TaskPersonWithCapacity extends TaskPerson {
  /** Hours absorbed on a normal working day. null only if the server had none. */
  capacityHours: number | null;
  /** Hours per weekday (0=Sun..6=Sat) for somebody whose days differ — #42. */
  hoursByWeekday?: number[] | null;
  /** Weekday numbers worked (0=Sunday..6=Saturday), or null if never set. */
  workingDays: number[] | null;
  /** False when capacityHours is the platform default rather than a real setting. */
  capacityConfigured: boolean;
}

export interface ClientTaskFile {
  id: string;
  client: string;
  opponent: string;
  companyId: string;
  companyNameEn: string;
  companyNameAr: string;
  /**
   * The folder's Google Drive link — access-gated server-side. Present only when
   * the caller has an active access grant to the folder; null/absent otherwise.
   */
  driveLink?: string | null;
  /**
   * Folder section + company color-ladder settings — echoed so the client can
   * reuse the shared color engine for the per-task "time until next color"
   * countdown. Optional so older payloads degrade gracefully (no countdown).
   */
  section?: FileSection;
  workingDays?: number[];
  daysPerColorStep?: number;
  /**
   * PER-VIEWER folder color — derived server-side from THIS employee's own open
   * tasks in the folder. null when they have no open task there (UI shows a
   * neutral folder). Each employee sees the same folder in their own color.
   */
  color?: FileColor | null;
}

export interface ClientTaskWithFile extends ClientTask {
  file: ClientTaskFile;
}

/** A person's display name in the active language, with sane fallbacks. */
export function taskPersonName(
  p: TaskPerson | null | undefined,
  lang: Lang
): string {
  if (!p) return '—';
  return (
    (lang === 'ar' ? p.fullNameAr : p.fullNameEn) || p.fullNameEn || p.username
  );
}

/** First letter of a name for an avatar chip. */
export function taskInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

/**
 * Localized date for task rows. Delegates to the shared formatter so every date
 * on the platform reads the same: "9 يوليو 2026" (ar) / "9 July 2026" (en) —
 * Latin digits, no comma.
 */
export function formatTaskDate(iso: string, lang: Lang): string {
  return formatDate(iso, lang);
}

/** The bilingual label for a task status. */
export function statusLabel(status: TaskStatus, t: Strings): string {
  if (status === 'approved') return t.statusApproved;
  if (status === 'awaiting_approval') return t.statusAwaiting;
  return t.statusOpen;
}

/** A palette hint per status (open=gold, awaiting=amber, approved=green). */
export function statusColor(status: TaskStatus): string {
  if (status === 'approved') return '#5E8C70';
  if (status === 'awaiting_approval') return '#c9892f';
  return '#bd9446';
}
