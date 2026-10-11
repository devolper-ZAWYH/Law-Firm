'use client';

import { useMemo } from 'react';
import {
  taskInitial,
  taskPersonName,
  type ClientTaskWithFile,
  type TaskPersonWithCapacity,
} from './taskTypes';

/**
 * THE WORKLOAD CALENDAR — a month grid that answers "who is overloaded, and
 * when", which is the question the Employee Tasks screen exists to answer and
 * the one a list of tasks cannot.
 *
 * WHAT A DAY CELL SHOWS, AND WHY IT IS NOT THE TASKS
 *   One row per person: their initial, a bar, and "planned / capacity h". Not
 *   the task titles. A month of titles is forty cells of six-point text that
 *   nobody reads and that hides the only thing visible at this zoom — that
 *   Wednesday is red and Thursday is empty. The titles are one click away: the
 *   cell opens the day.
 *
 * WHICH DAY A TASK LANDS ON
 *   Its `scheduledDate` and nothing else. This is the deliberate difference
 *   from the old calendar, which fell back to the due date and then to the
 *   assignment date so that every task appeared SOMEWHERE. That was right for a
 *   calendar of deadlines and wrong for a calendar of work: a task placed on
 *   its deadline says the work happens the day it is due, which is exactly the
 *   planning mistake the load bars exist to expose. A task nobody has planned
 *   is not on a day at all — it is in the unscheduled pile beside the month.
 *
 * THE BAR
 *   Green under capacity, red over it. Only tasks WITH an estimate count: a
 *   task nobody has sized contributes nothing, because the alternative is
 *   inventing a number and drawing a bar that looks like measurement. A day
 *   carrying unestimated work says so with a small mark instead of guessing.
 */

/**
 * HOW MUCH TIME THE GRID SHOWS AT ONCE.
 *
 * A month is the right frame for "when is this quarter's pressure", and the
 * wrong one for reading a single Tuesday: at seven columns each day is a
 * sliver, and a firm with a dozen people stacks a dozen bars into it. The
 * shorter ranges trade span for room — the same cells, fewer of them, each
 * correspondingly larger — so a week is legible and a single day can print
 * every person's NAME beside their bar instead of one initial.
 */
export type CalendarRange = 'day' | 'week' | 'biweek' | 'month';

export interface WorkloadCalendarProps {
  /** Every open task; the ones with no scheduledDate are simply not placed. */
  tasks: ClientTaskWithFile[];
  /** The roster whose rows each day shows, already filtered by the caller. */
  people: TaskPersonWithCapacity[];
  /** The focused date. Which days are drawn around it depends on `range`. */
  anchor: Date;
  range: CalendarRange;
  lang: 'en' | 'ar';
  /** Whether a task may be dropped onto a day (manager/admin only). */
  canPlan: boolean;
  /** The day currently opened, as 'YYYY-MM-DD', or null. */
  openDay: string | null;
  onOpenDay: (dayKey: string) => void;
  /** A task was dropped onto a day. */
  onPlanTask: (taskId: string, dayKey: string) => void;
}

const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_AR = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

/**
 * Local YYYY-MM-DD. Deliberately not toISOString(), which converts to UTC and
 * would file an evening task under the next day for anyone east of London.
 * Must stay byte-identical to what the API stores in `scheduled_date`.
 */
export function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The tasks planned onto one day, for one person. */
export function tasksOn(
  tasks: ClientTaskWithFile[],
  key: string,
  userId?: string
): ClientTaskWithFile[] {
  return tasks.filter(
    (tk) =>
      tk.scheduledDate === key &&
      (userId === undefined || tk.assignee?.userId === userId)
  );
}

/** One person's planned hours on one day, ignoring tasks with no estimate. */
function plannedHours(tasks: ClientTaskWithFile[]): number {
  return tasks.reduce((sum, tk) => sum + (tk.estimatedHours ?? 0), 0);
}

/**
 * Hours as people write them: 0.5, 2, 4.25 — never "4.00" or "0.50". A load bar
 * is scanned, not read, and trailing zeros are noise at that speed.
 */
export function formatHours(h: number): string {
  return `${Math.round(h * 100) / 100}`;
}

/**
 * A task's estimate, in MINUTES — which is how people give one.
 *
 * "0.25" is not how anybody says a quarter of an hour, and the fractions the
 * hour form produced (0.08, 0.17) were unreadable as durations. The column
 * stays `estimated_hours` numeric(6,2), because stored names are permanent and
 * the DAY totals are still measured in hours against a working day; only the
 * per-task number a person types and reads is minutes.
 *
 * Two decimal places of an hour round-trip through minutes exactly at this
 * scale: 5 min → 0.08 h → 5 min, 25 min → 0.42 h → 25 min.
 */
export function formatMinutes(hours: number): string {
  return `${Math.round(hours * 60)}`;
}

/** Minutes as the hours the column stores, at its own precision. */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** Midnight local, so date arithmetic never drifts on a DST boundary. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The Sunday on or before `d` — the week always starts where the header does. */
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** How many days each range spans, and how many columns it lays them out in. */
const RANGE_SHAPE: Record<CalendarRange, { days: number; columns: number }> = {
  // One day, one column: the whole width for one date, which is what makes
  // room for names rather than initials.
  day: { days: 1, columns: 1 },
  week: { days: 7, columns: 7 },
  biweek: { days: 14, columns: 7 },
  // Six weeks, always — a month laid out in whole weeks never reflows its
  // height as you page through, whatever weekday the 1st falls on.
  month: { days: 42, columns: 7 },
};

/** The days a range covers, in order. */
export function daysForRange(anchor: Date, range: CalendarRange): Date[] {
  const { days } = RANGE_SHAPE[range];
  let start: Date;
  if (range === 'day') start = startOfDay(anchor);
  else if (range === 'month') {
    start = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  } else start = startOfWeek(anchor);
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

/** Move the anchor one whole range forward (+1) or back (-1). */
export function shiftAnchor(
  anchor: Date,
  range: CalendarRange,
  direction: 1 | -1
): Date {
  if (range === 'month') {
    return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  }
  return addDays(anchor, RANGE_SHAPE[range].days * direction);
}

/**
 * The heading above the grid. A month says "August 2026"; the shorter ranges
 * say which days they actually cover, because "August 2026" over a single week
 * tells you nothing about WHICH week you are looking at.
 */
export function rangeLabel(
  anchor: Date,
  range: CalendarRange,
  lang: 'en' | 'ar'
): string {
  const locale = lang === 'ar' ? 'ar' : 'en';
  if (range === 'month') return monthLabel(anchor, lang);
  const days = daysForRange(anchor, range);
  const first = days[0];
  const last = days[days.length - 1];
  if (range === 'day') {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(first);
  }
  // formatRange, not two formats joined by a dash.
  //
  // Doing it by hand produced "23 – August 29, 2026" for a range inside ONE
  // month: the start had no month (it is shared) and en-US puts the month
  // BEFORE the day, so the month name landed between the two numbers. Getting
  // that right by hand means encoding, per locale, whether the month leads or
  // trails and which parts may be elided — which is exactly what formatRange
  // already knows: "August 23 – 29, 2026" in English, "٢٣–٢٩ أغسطس ٢٠٢٦" in
  // Arabic, and both months spelled out when the range crosses one.
  const fmt = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  try {
    return fmt.formatRange(first, last);
  } catch {
    // Very old engines lack formatRange. Two full dates is clumsy but never
    // ambiguous, which is the property that matters in a fallback.
    return `${fmt.format(first)} – ${fmt.format(last)}`;
  }
}

export default function WorkloadCalendar({
  tasks,
  people,
  anchor,
  range,
  lang,
  canPlan,
  openDay,
  onOpenDay,
  onPlanTask,
}: WorkloadCalendarProps) {
  const ar = lang === 'ar';
  const weekdays = ar ? WEEKDAYS_AR : WEEKDAYS_EN;

  // Index the scheduled tasks once: day → assignee → tasks. The grid asks for
  // (day, person) 42 × |people| times per render, and filtering the whole task
  // list for each of those is the difference between instant and visibly slow
  // once a company has a few hundred open tasks.
  const index = useMemo(() => {
    const byDay = new Map<string, Map<string, ClientTaskWithFile[]>>();
    for (const tk of tasks) {
      if (!tk.scheduledDate) continue; // unscheduled — it lives in the pile
      const who = tk.assignee?.userId;
      if (!who) continue; // no assignee → no row to add it to
      let byPerson = byDay.get(tk.scheduledDate);
      if (!byPerson) {
        byPerson = new Map();
        byDay.set(tk.scheduledDate, byPerson);
      }
      const list = byPerson.get(who);
      if (list) list.push(tk);
      else byPerson.set(who, [tk]);
    }
    return byDay;
  }, [tasks]);

  const cells = useMemo(() => daysForRange(anchor, range), [anchor, range]);

  const todayKey = dayKey(new Date());
  const shownMonth = anchor.getMonth();
  const { columns } = RANGE_SHAPE[range];
  // Only a MONTH has neighbouring-month days to dim. In a week or a fortnight
  // every cell is one you asked for, and dimming five of seven would be a lie
  // about which days the range covers.
  const dimsOutside = range === 'month';
  // With one column there is width for a person's name, which is the whole
  // reason to look at a single day rather than a month.
  const showNames = columns === 1;

  return (
    <div
      className={`wl-cal is-${range}`}
      dir={ar ? 'rtl' : 'ltr'}
      style={{ ['--wl-cols' as string]: columns }}
    >
      {/* A single day names its own weekday in the heading above, so a row of
          seven weekday labels over one column would be noise. */}
      {columns === 7 && (
        <div className="wl-cal-head">
          {weekdays.map((w) => (
            <div key={w} className="wl-cal-weekday">
              {w}
            </div>
          ))}
        </div>
      )}
      <div className="wl-cal-grid">
        {cells.map((d) => {
          const key = dayKey(d);
          const byPerson = index.get(key);
          const outside = dimsOutside && d.getMonth() !== shownMonth;
          const weekday = d.getDay();
          return (
            <div
              key={key}
              className={[
                'wl-cal-cell',
                outside ? 'is-outside' : '',
                key === todayKey ? 'is-today' : '',
                openDay === key ? 'is-open' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              // The whole cell is the drop target, not just the bars: aiming at
              // a 6px bar is a precision task, and the day is what the manager
              // means when they let go anywhere inside it.
              onDragOver={
                canPlan
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }
                  : undefined
              }
              onDrop={
                canPlan
                  ? (e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain');
                      if (id) onPlanTask(id, key);
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="wl-cal-daynum"
                onClick={() => onOpenDay(key)}
                title={ar ? 'افتح اليوم' : 'Click to open the day'}
              >
                {/* In a week or a fortnight a bare number is ambiguous — the
                    weekday header is the only other clue, and it repeats. The
                    shorter ranges print the weekday with the date.

                    Built from the same WEEKDAYS array as the header rather
                    than by Intl: asking Intl for weekday+day alone yields
                    "30 Sun" in en-US, which reads as a date followed by a
                    stray word. */}
                {columns === 7 && range !== 'month'
                  ? `${weekdays[d.getDay()]} ${d.getDate()}`
                  : d.getDate()}
              </button>
              <div className="wl-cal-rows">
                {people.map((p) => {
                  const own = byPerson?.get(p.userId) ?? [];
                  const planned = plannedHours(own);
                  // PER-WEEKDAY FIRST. Somebody with a block schedule (#42)
                  // has a Monday of six hours and a Thursday of three; one flat
                  // number drew Thursday as half-empty when it was full.
                  const perDay = p.hoursByWeekday?.[weekday];
                  const capacity =
                    perDay !== undefined && perDay !== null
                      ? perDay
                      : p.capacityHours ?? 0;
                  // A day outside this person's working days has no allowance
                  // at all, so anything planned on it is over capacity however
                  // small — which is the honest reading of work on a day off.
                  const worksToday =
                    p.workingDays === null || p.workingDays.includes(weekday);
                  const allowance = worksToday ? capacity : 0;
                  const over = planned > allowance;
                  // Clamped so an overloaded bar fills the track rather than
                  // overflowing it; the number beside it carries the excess.
                  const pct =
                    allowance > 0
                      ? Math.min(100, (planned / allowance) * 100)
                      : planned > 0
                      ? 100
                      : 0;
                  // Work planned but never sized — the bar cannot show it, so
                  // the row says it is there rather than quietly omitting it.
                  const unsized = own.some((tk) => tk.estimatedHours === null);
                  return (
                    <div
                      key={p.userId}
                      className={`wl-row${over ? ' is-over' : ''}${
                        worksToday ? '' : ' is-offday'
                      }`}
                      title={`${taskPersonName(p, lang)} — ${formatHours(
                        planned
                      )}/${formatHours(allowance)}h${
                        unsized ? (ar ? ' — مهام بلا تقدير' : ' — unestimated work') : ''
                      }`}
                    >
                      {/* An initial is all that fits in a seventh of the width.
                          A single day has room for the actual name, which is
                          the point of looking at one day. */}
                      {showNames ? (
                        <span className="wl-row-name" dir="auto">
                          {taskPersonName(p, lang)}
                        </span>
                      ) : (
                        <span className="wl-row-who" aria-hidden="true">
                          {taskInitial(taskPersonName(p, lang))}
                        </span>
                      )}
                      <span className="wl-row-track">
                        <span
                          className="wl-row-fill"
                          style={{ inlineSize: `${pct}%` }}
                        />
                      </span>
                      <span className="wl-row-num" dir="ltr">
                        {unsized && (
                          <span className="wl-row-unsized" aria-hidden="true">
                            ·
                          </span>
                        )}
                        {formatHours(planned)}/{formatHours(allowance)}h
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Month label like "March 2026" / "مارس ٢٠٢٦". */
export function monthLabel(month: Date, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', {
    month: 'long',
    year: 'numeric',
  }).format(month);
}

/**
 * A 'YYYY-MM-DD' key back to a LOCAL Date.
 *
 * `new Date('2026-03-12')` parses a date-only string as UTC midnight, which
 * renders as the 11th for every viewer west of Greenwich — a task planned for
 * Thursday would be labelled Wednesday. Feeding the parts to the constructor
 * builds the day in local time, which is the only reading a plain calendar day
 * has.
 */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** A full day label for the opened-day panel ("Wednesday 12 March 2026"). */
export function dayLabel(key: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(parseDayKey(key));
}
