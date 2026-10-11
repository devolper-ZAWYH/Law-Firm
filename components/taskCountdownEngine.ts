// Per-task "time until next color" countdown — pure, CLIENT-SAFE.
//
// It does NOT fork the color logic: it reuses the shared color engine
// (lib/platform/colorEngine) and palette (lib/platform/fileColors) so a task's
// step math, WORKING-time accrual (weekends excluded via the company's
// working_days) and pause/resume model stay identical to the server's.
//
// The next-color threshold is derived from the same engine: a task advances a
// step every `days_per_color_step` WORKING days, so the boundary for the next
// color is (currentSteps + 1) * perStep * 86400 working-seconds. The remaining
// is that boundary minus the task's accrued working-seconds — clamped to >= 0.

import type { Lang } from '@/lib/i18n';
import type { FileSection, FileStatusColorName } from '@/lib/platform/fileColors';
import { FILE_STATUS_PALETTE } from '@/lib/platform/fileColors';
import {
  SECTION_LADDER,
  isClosedSection,
  overdueSteps,
  effectiveOverdueWorkingSeconds,
  type ColorTask,
  type ColorCompanySettings,
} from '@/lib/platform/colorEngine';

/** A full working DAY = 24h of working-time (matches the color engine). */
const WORKING_SECONDS_PER_DAY = 86400;

export type CountdownState =
  | 'running' // open + not at the last color: ticks down toward the next color
  | 'frozen' // awaiting_approval: clock paused at "done" — value does NOT tick
  | 'overdue' // already at the last ladder color (red): nothing left to count
  | 'done'; // approved, or an expired/green folder — no countdown at all

export interface TaskCountdown {
  state: CountdownState;
  currentColorKey: FileStatusColorName;
  currentHex: string;
  nextColorKey: FileStatusColorName | null;
  nextHex: string | null;
  /** WORKING-seconds until the next color (>= 0). null when N/A (done/overdue). */
  remainingSeconds: number | null;
  /** Whole WORKING DAYS the task is currently overdue (floored, >= 0). */
  overdueWorkingDays: number;
}

/** The minimal per-task timer fields the countdown needs (subset of ClientTask). */
export interface CountdownTaskInput {
  status: 'open' | 'awaiting_approval' | 'approved';
  accumulatedWorkingSeconds: number;
  lastResumedAt: string | null;
  assignedAt: string;
}

/**
 * Compute a task's countdown to its next color at instant `now`. Returns null
 * when the payload lacks the settings needed to run the engine (older payloads
 * degrade to "no countdown" rather than showing a wrong number).
 */
export function computeTaskCountdown(
  task: CountdownTaskInput,
  section: FileSection | undefined,
  workingDays: number[] | undefined,
  daysPerColorStep: number | undefined,
  now: Date
): TaskCountdown | null {
  if (!section) return null;
  const wd =
    Array.isArray(workingDays) && workingDays.length > 0 ? workingDays : null;
  const perStep =
    typeof daysPerColorStep === 'number' && daysPerColorStep > 0
      ? daysPerColorStep
      : null;
  if (!wd || !perStep) return null;

  // Approved task, or a CLOSED folder → nothing to count.
  //
  // Closed means expired (matter closed cleanly) or attrition (client left /
  // contract ended early). Attrition used to be missing here, so a folder that
  // had been written off kept ticking and its tasks still read as in progress.
  // The tasks are kept — they just stop counting.
  const closed = isClosedSection(section);
  if (task.status === 'approved' || closed) {
    const restKey = SECTION_LADDER[section][0] ?? 'green';
    return {
      state: 'done',
      currentColorKey: restKey,
      currentHex: FILE_STATUS_PALETTE[restKey],
      nextColorKey: null,
      nextHex: null,
      remainingSeconds: null,
      overdueWorkingDays: 0,
    };
  }

  const ladder = SECTION_LADDER[section]; // potential | active
  const company: ColorCompanySettings = {
    workingDays: wd,
    daysPerColorStep: perStep,
  };
  const colorTask: ColorTask = {
    status: task.status,
    accumulatedWorkingSeconds: Number.isFinite(task.accumulatedWorkingSeconds)
      ? task.accumulatedWorkingSeconds
      : 0,
    lastResumedAt: task.lastResumedAt,
    assignedAt: task.assignedAt,
  };

  // Accrued WORKING-seconds (frozen for awaiting_approval; live for open — the
  // engine already excludes weekend seconds, so a live tick naturally pauses
  // over Fri/Sat). Drives BOTH the whole-days-overdue readout and the step math.
  const accrued = effectiveOverdueWorkingSeconds(colorTask, now, wd);
  const overdueWorkingDays = Math.max(
    0,
    Math.floor(accrued / WORKING_SECONDS_PER_DAY)
  );

  // Step boundaries are DERIVED from days_per_color_step (perStep), never
  // hardcoded: the task is at step `floor(overdueWorkingDays / perStep)`, and
  // it advances when its accrued working-time crosses the NEXT multiple of
  // perStep working days. With perStep = 3 → boundaries at 3, 6, 9 … working
  // days (yellow < 3 ≤ orange < 6 ≤ red). Change perStep to 5 → 5, 10, 15 …
  const steps = overdueSteps(colorTask, company, now); // floor(days/perStep) >= 0
  const lastIndex = ladder.length - 1;
  const currentIndex = Math.max(0, Math.min(steps, lastIndex));
  const currentColorKey = ladder[currentIndex];
  const currentHex = FILE_STATUS_PALETTE[currentColorKey];

  // awaiting_approval = the timer is frozen ("paused") at the done moment.
  const frozen = task.status === 'awaiting_approval';

  // Already at the last color (red) → no forward countdown; it's overdue.
  if (currentIndex >= lastIndex) {
    return {
      state: frozen ? 'frozen' : 'overdue',
      currentColorKey,
      currentHex,
      nextColorKey: null,
      nextHex: null,
      remainingSeconds: null,
      overdueWorkingDays,
    };
  }

  const nextColorKey = ladder[currentIndex + 1];
  const nextHex = FILE_STATUS_PALETTE[nextColorKey];

  // Remaining working-time until the NEXT step boundary = (steps+1)*perStep days.
  const threshold = (steps + 1) * perStep * WORKING_SECONDS_PER_DAY;
  let remaining = threshold - accrued;
  if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;

  return {
    state: frozen ? 'frozen' : 'running',
    currentColorKey,
    currentHex,
    nextColorKey,
    nextHex,
    remainingSeconds: remaining,
    overdueWorkingDays,
  };
}

/** Bilingual display name for a ladder color (Latin script; AR is translated). */
export function colorName(key: FileStatusColorName, lang: Lang): string {
  const en: Record<FileStatusColorName, string> = {
    lgray: 'light gray',
    dgray: 'dark gray',
    yellow: 'yellow',
    orange: 'orange',
    red: 'red',
    green: 'green',
  };
  const ar: Record<FileStatusColorName, string> = {
    lgray: 'رمادي فاتح',
    dgray: 'رمادي غامق',
    yellow: 'أصفر',
    orange: 'برتقالي',
    red: 'أحمر',
    green: 'أخضر',
  };
  return (lang === 'ar' ? ar : en)[key];
}

/**
 * Format WORKING-seconds remaining as a compact bilingual string with LATIN
 * digits (matching the platform's date standard): "2d 4h" / "2 يوم 4 ساعة".
 * A working day here is 24h of working-time (86400 working-seconds).
 */
export function formatRemaining(seconds: number, lang: Lang): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const days = Math.floor(safe / WORKING_SECONDS_PER_DAY);
  const hours = Math.floor((safe % WORKING_SECONDS_PER_DAY) / 3600);
  const minutes = Math.floor((safe % 3600) / 60);

  if (lang === 'ar') {
    if (days > 0) return `${days} يوم ${hours} ساعة`;
    if (hours > 0) return `${hours} ساعة ${minutes} دقيقة`;
    if (minutes > 0) return `${minutes} دقيقة`;
    return 'أقل من دقيقة';
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

/**
 * Whole WORKING DAYS as a bilingual phrase with LATIN digits:
 * "3 working days" / "3 أيام عمل" (with correct AR singular/dual/plural).
 */
export function formatWorkingDays(n: number, lang: Lang): string {
  const d = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (lang === 'ar') {
    if (d === 1) return 'يوم عمل واحد';
    if (d === 2) return 'يومَا عمل';
    if (d >= 3 && d <= 10) return `${d} أيام عمل`;
    return `${d} يوم عمل`;
  }
  return `${d} working day${d === 1 ? '' : 's'}`;
}
