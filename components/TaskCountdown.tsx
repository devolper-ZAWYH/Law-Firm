'use client';

import { useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import type { FileSection } from '@/lib/platform/fileColors';
import {
  computeTaskCountdown,
  colorName,
  formatRemaining,
  formatWorkingDays,
  type CountdownTaskInput,
} from './taskCountdownEngine';

/**
 * Per-task countdown to the NEXT color. LIVE: it re-renders every 60s (never
 * every second) via a self-clearing interval, recomputing against the shared
 * color engine — which measures WORKING-time only, so the value naturally
 * freezes over weekends and while a task is paused (awaiting_approval). The
 * authoritative thresholds come from that engine; the client just re-evaluates
 * `now`. Renders nothing when there's no countdown to show (done / approved /
 * expired / missing settings).
 */

/** A minute clock: returns `now`, updated every 60s; the interval is cleared on
 * unmount so no timer leaks when a list re-renders or a modal closes. */
function useMinuteNow(): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function TaskCountdown({
  task,
  section,
  workingDays,
  daysPerColorStep,
}: {
  task: CountdownTaskInput;
  section: FileSection | undefined;
  workingDays: number[] | undefined;
  daysPerColorStep: number | undefined;
}) {
  const { lang } = useDash();
  const now = useMinuteNow();

  const cd = computeTaskCountdown(
    task,
    section,
    workingDays,
    daysPerColorStep,
    now
  );

  // No countdown to show (approved / expired / missing settings).
  if (!cd || cd.state === 'done') return null;

  const currentDot = (
    <span
      className="tc-dot"
      style={{ background: cd.currentHex }}
      aria-hidden="true"
    />
  );

  const overdue = cd.overdueWorkingDays;
  const overdueFull = formatWorkingDays(overdue, lang);
  // Compact inline "overdue" readout (full phrase lives in the title).
  const overdueShort =
    lang === 'ar' ? `متأخرة ${overdue} يوم` : `${overdue}d overdue`;
  const arrow = lang === 'ar' ? '←' : '→';

  // Already at the LAST color (red) → no next color: overdue state, no countdown.
  if (cd.state === 'overdue') {
    const text =
      lang === 'ar' ? `متأخرة ${overdueFull}` : `${overdueFull} overdue`;
    const title =
      lang === 'ar'
        ? `عند آخر لون (الأحمر) — ${text}`
        : `At the last color (red) — ${text}`;
    return (
      <span className="task-countdown is-overdue" title={title} dir="auto">
        {currentDot}
        <span className="tc-text" style={{ color: cd.currentHex }}>
          {text}
        </span>
      </span>
    );
  }

  const remaining =
    cd.remainingSeconds != null ? formatRemaining(cd.remainingSeconds, lang) : '';
  const nextName = cd.nextColorKey ? colorName(cd.nextColorKey, lang) : '';

  // Paused (awaiting approval): frozen — the overdue value + countdown do NOT tick.
  if (cd.state === 'frozen') {
    const text =
      lang === 'ar' ? `${overdueShort} · متوقّفة` : `${overdueShort} · paused`;
    const title =
      lang === 'ar'
        ? `متوقّفة — بانتظار الاعتماد · ${overdueFull} (تتحوّل إلى ${nextName})`
        : `Paused — awaiting approval · ${overdueFull} (turns ${nextName})`;
    return (
      <span className="task-countdown is-paused" title={title} dir="auto">
        {currentDot}
        <span className="tc-pause" aria-hidden="true">
          ⏸
        </span>
        <span className="tc-text tc-muted">{text}</span>
      </span>
    );
  }

  // Running: current color + working-days overdue + countdown to the next color.
  const countdownText =
    lang === 'ar'
      ? `متبقي ${remaining} ${arrow} ${nextName}`
      : `${remaining} left ${arrow} ${nextName}`;
  const title =
    lang === 'ar'
      ? `${overdueShort} — تتحوّل إلى ${nextName} خلال ${remaining} من وقت العمل`
      : `${overdueFull} overdue — turns ${nextName} in ${remaining} of working time`;
  return (
    <span className="task-countdown" title={title} dir="auto">
      {currentDot}
      <span className="tc-text" style={{ color: cd.currentHex }}>
        {overdueShort}
      </span>
      <span className="tc-sep" aria-hidden="true">
        ·
      </span>
      <span className="tc-text" style={{ color: cd.nextHex ?? undefined }}>
        {countdownText}
      </span>
      {cd.nextHex && (
        <span
          className="tc-dot tc-dot-next"
          style={{ background: cd.nextHex }}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
