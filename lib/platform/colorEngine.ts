// Color & overdue-timer engine (Phase 5).
//
// CLIENT-SAFE (no `server-only`): a pure module with no I/O. It only depends on
// workingTime (pure) and fileColors (pure palette), so it can be reused on the
// server (files data layer computes each file's color on read) AND in the
// browser (the file-detail step bar reconstructs the section ladder).
//
// COLOR IS DERIVED, NEVER STORED. A file's color is a function of its OPEN /
// AWAITING tasks and the company's settings, evaluated at read time:
//
//   • Per task we measure OVERDUE WORKING-TIME — the working-time the task has
//     been alive (frozen while it sits in awaiting_approval). See
//     effectiveOverdueWorkingSeconds — it reuses Phase-4's exact timer model
//     (accumulated_working_seconds + workingSecondsBetween since last_resumed_at).
//   • Working-seconds → working-DAYS by /86400 (a full working day = 24h of
//     working-time, and workingSecondsBetween already counts only seconds that
//     fall on the company's working_days, so weekends never accrue).
//   • overdueSteps = floor(overdueWorkingDays / days_per_color_step).
//   • The file takes the MAX step across its unfinished tasks and maps it onto
//     its SECTION's color ladder (clamped to the last color). GREEN is ONLY the
//     expired color — a potential/active file sits at its ladder's step 0
//     (light gray / yellow) when it has no open or overdue tasks, never green.
//
// LADDERS (spec §7.2):
//   • potential → [lgray, dgray, yellow, orange, red]   (starts light gray)
//   • active    → [yellow, orange, red]                 (skips the two grays)
//   • expired   → [green]                               (closed / resolved)
//
// So with the default days_per_color_step = 3 and Sun–Thu working days, an
// ACTIVE file's single task advances: yellow at 0–2 working days overdue →
// orange at 3–5 → red at 6+ (6 WORKING days = ~8 calendar days across one
// weekend). A POTENTIAL file starts two steps earlier (light gray, dark gray)
// before it reaches yellow, so it needs 6 working days to hit yellow and 12+ to
// hit red. Because the color is computed on read, each page load reflects the
// current overdue — no stored column, no cron (alert transitions are Phase 7).

import { workingSecondsBetween } from './workingTime';
import {
  FILE_STATUS_PALETTE,
  type FileSection,
  type FileStatusColorName,
} from './fileColors';

/** The minimal task shape the engine needs (mirrors the Phase-4 timer fields). */
export interface ColorTask {
  status: 'open' | 'awaiting_approval' | 'approved';
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
  assignedAt: string;
}

/** The company settings that drive the ladder (companies table). */
export interface ColorCompanySettings {
  workingDays: number[];
  daysPerColorStep: number;
}

/** The minimal file shape the engine needs. */
export interface ColorFileInput {
  section: FileSection;
}

/** Alert level for later phases (Phase 7 notifications) — derived, not stored. */
export type AlertLevel = 'none' | 'warn' | 'critical';

/** The computed color a file is painted with, plus data the UI step bar needs. */
export interface FileColor {
  colorKey: FileStatusColorName;
  hex: string;
  /** Position within the section ladder (0-based, clamped to the last color). */
  stepIndex: number;
  /** Number of colors in the applicable ladder (for the step-bar fill ratio). */
  ladderLength: number;
  alertLevel: AlertLevel;
  /** Raw, UNclamped step count (max across the file's tasks) — for debugging. */
  overdueSteps: number;
}

/** A full working DAY = 24h of working-time. Seconds → working-days by /86400. */
const WORKING_SECONDS_PER_DAY = 86400;

/** The color ladder each section climbs as its tasks go overdue. */
export const SECTION_LADDER: Record<FileSection, FileStatusColorName[]> = {
  potential: ['lgray', 'dgray', 'yellow', 'orange', 'red'],
  active: ['yellow', 'orange', 'red'],
  expired: ['green'],
  attrition: ['dgray'],
};

/**
 * Sections whose color is fixed (closed) rather than derived from tasks.
 *
 * A CLOSED section also means its tasks stop counting: the work is over, so no
 * clock runs, nothing goes overdue, and nothing is "in progress".
 *   • expired   — the matter closed cleanly
 *   • attrition — the client left / the contract ended early
 * The tasks themselves are kept for the record; they simply stop accruing.
 *
 * Exported so the live countdown in the browser (components/taskCountdownEngine)
 * applies the same rule — the two used to disagree about attrition.
 */
export const CLOSED_SECTIONS: readonly FileSection[] = ['expired', 'attrition'];

/** True when a section is terminal, so its tasks no longer count. */
export function isClosedSection(section: FileSection): boolean {
  return CLOSED_SECTIONS.includes(section);
}

/**
 * The overdue WORKING-seconds a task has accrued as of `now`, using Phase-4's
 * timer model exactly:
 *   • open              → accumulated + working-seconds since last_resumed_at
 *                         (falls back to assigned_at if the clock was never
 *                         explicitly resumed).
 *   • awaiting_approval → accumulated (FROZEN — the clock stopped at "done").
 *   • approved / other  → 0 (closed; not counted).
 */
export function effectiveOverdueWorkingSeconds(
  task: ColorTask,
  now: Date,
  workingDays: number[]
): number {
  const accumulated = Number.isFinite(task.accumulatedWorkingSeconds)
    ? task.accumulatedWorkingSeconds
    : 0;

  if (task.status === 'awaiting_approval') return accumulated; // frozen
  if (task.status !== 'open') return 0; // approved / closed — not counted

  const from = task.lastResumedAt ?? task.assignedAt;
  if (!from) return accumulated;
  const fromDate = new Date(from);
  if (Number.isNaN(fromDate.getTime())) return accumulated;

  const live = workingSecondsBetween(fromDate, now, workingDays);
  return accumulated + live;
}

/** Overdue working-time expressed in working-DAYS (fractional). */
export function overdueWorkingDays(
  task: ColorTask,
  company: ColorCompanySettings,
  now: Date
): number {
  const seconds = effectiveOverdueWorkingSeconds(
    task,
    now,
    company.workingDays
  );
  return seconds / WORKING_SECONDS_PER_DAY;
}

/**
 * How many color steps a single task has advanced:
 *   floor(overdueWorkingDays / days_per_color_step).
 * days_per_color_step is guarded to at least 1 to avoid a divide-by-zero.
 */
export function overdueSteps(
  task: ColorTask,
  company: ColorCompanySettings,
  now: Date = new Date()
): number {
  const perStep =
    Number.isFinite(company.daysPerColorStep) && company.daysPerColorStep > 0
      ? company.daysPerColorStep
      : 1;
  const days = overdueWorkingDays(task, company, now);
  if (!(days > 0)) return 0;
  return Math.floor(days / perStep);
}

const GREEN_KEY: FileStatusColorName = 'green';

function alertFor(key: FileStatusColorName): AlertLevel {
  if (key === 'red') return 'critical';
  if (key === 'orange') return 'warn';
  return 'none';
}

/**
 * The computed color for a file (spec §7.2):
 *   • section 'expired' → GREEN (closed). Green is ONLY the expired color.
 *   • otherwise (potential OR active): the SECTION's ladder at
 *     stepIndex = max(overdueSteps) across the file's unfinished tasks
 *     (0 if there are none / none overdue yet). So a task-less or fresh
 *     POTENTIAL file = light gray (step 0) and a fresh ACTIVE file = yellow
 *     (step 0) — a non-expired file is NEVER green just because it has no tasks.
 *
 * `now` is injectable so the same math is testable and deterministic; the
 * server passes a single `new Date()` per request so every file in the list is
 * evaluated at one instant.
 */
export function fileColor(
  file: ColorFileInput,
  openTasks: ColorTask[],
  company: ColorCompanySettings,
  now: Date = new Date()
): FileColor {
  // Closed sections have a single fixed color, not derived from tasks:
  // expired → green (clean close), attrition → dark gray (client/contract lost).
  if (CLOSED_SECTIONS.includes(file.section)) {
    const key = SECTION_LADDER[file.section][0] ?? GREEN_KEY;
    return {
      colorKey: key,
      hex: FILE_STATUS_PALETTE[key],
      stepIndex: 0,
      ladderLength: SECTION_LADDER[file.section].length, // 1
      alertLevel: 'none',
      overdueSteps: 0,
    };
  }

  const unfinished = Array.isArray(openTasks)
    ? openTasks.filter(
        (tk) => tk.status === 'open' || tk.status === 'awaiting_approval'
      )
    : [];

  // Potential / active: climb the section ladder from step 0. With no unfinished
  // (or no overdue) tasks maxSteps stays 0, so the file sits at its section's
  // starting color (potential → light gray, active → yellow).
  const ladder = SECTION_LADDER[file.section]; // potential | active
  let maxSteps = 0;
  for (const tk of unfinished) {
    const s = overdueSteps(tk, company, now);
    if (s > maxSteps) maxSteps = s;
  }

  const lastIndex = ladder.length - 1;
  const stepIndex = Math.max(0, Math.min(maxSteps, lastIndex));
  const key = ladder[stepIndex] ?? ladder[lastIndex] ?? GREEN_KEY;

  return {
    colorKey: key,
    hex: FILE_STATUS_PALETTE[key],
    stepIndex,
    ladderLength: ladder.length,
    alertLevel: alertFor(key),
    overdueSteps: maxSteps,
  };
}
