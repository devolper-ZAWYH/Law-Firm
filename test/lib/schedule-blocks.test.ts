import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  computeLateMinutes,
  firstOfficeStartMinutes,
  hasAnyBlock,
  scheduledMinutes,
  type ScheduleBlock,
} from '@/lib/platform/lateness';

/**
 * The schedule this feature exists for — a real one, handed to us on paper:
 *
 *   Sunday     online 09:00–12:00, office 14:30–16:30
 *   Monday     office 09:00–15:00
 *   Tuesday    online 09:00–12:00, office 14:30–16:30
 *   Wednesday  online 09:00–15:00
 *   Thursday   office 09:00–12:00
 *
 * 25 hours a week: 13 in the office, 12 online. (The paper says 17 online,
 * which cannot be right — 13 + 17 is 30, and the same sheet totals 25.)
 *
 * Every case below is a day this schedule contains, because the single
 * start/end pair the portal had before could not express one of them.
 */
const SUN = 0;
const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;

const SCHEDULE: ScheduleBlock[] = [
  { weekday: SUN, startTime: '09:00', endTime: '12:00', mode: 'online' },
  { weekday: SUN, startTime: '14:30', endTime: '16:30', mode: 'office' },
  { weekday: MON, startTime: '09:00', endTime: '15:00', mode: 'office' },
  { weekday: TUE, startTime: '09:00', endTime: '12:00', mode: 'online' },
  { weekday: TUE, startTime: '14:30', endTime: '16:30', mode: 'office' },
  { weekday: WED, startTime: '09:00', endTime: '15:00', mode: 'online' },
  { weekday: THU, startTime: '09:00', endTime: '12:00', mode: 'office' },
];

/** 2026-09-06 is a Sunday; the days below follow it. */
const SUNDAY = '2026-09-06';
const MONDAY = '2026-09-07';
const WEDNESDAY = '2026-09-09';
const THURSDAY = '2026-09-10';
const FRIDAY = '2026-09-11';

function late(date: string, clockIn: string | null, sheet = 0) {
  return computeLateMinutes({
    date,
    clockIn,
    sheetLateMinutes: sheet,
    schedule: { workingDays: null, startTime: null, blocks: SCHEDULE },
  });
}

describe('the bug this feature fixes', () => {
  it('does NOT call somebody late for arriving at their office block', () => {
    // THE WHOLE POINT. Sunday opens with three hours online and reaches the
    // office at 14:30. Measured from 09:00 — which is all the old model could
    // do — this is 330 minutes late, every Sunday, for somebody who did
    // nothing wrong.
    expect(late(SUNDAY, '14:30')).toBe(0);
  });

  it('measures lateness from the OFFICE block, not the working day', () => {
    expect(late(SUNDAY, '14:45')).toBe(15);
    expect(late(SUNDAY, '15:30')).toBe(60);
  });

  it('still measures an ordinary all-office day from its start', () => {
    expect(late(MONDAY, '09:00')).toBe(0);
    expect(late(MONDAY, '09:20')).toBe(20);
  });

  it('treats arriving early as on time, never as negative', () => {
    expect(late(SUNDAY, '13:00')).toBe(0);
    expect(late(MONDAY, '08:30')).toBe(0);
  });
});

describe('a day with no office block', () => {
  it('is never late — the device cannot see online work', () => {
    // Wednesday is online 09:00–15:00. The reader records nothing all day,
    // and that silence means nothing at all.
    expect(late(WEDNESDAY, null)).toBe(0);
  });

  it('is not made late by the sheet\'s own figure either', () => {
    // A device row with a stale Late In(M) must not leak through on a day
    // nobody was expected in the office.
    expect(late(WEDNESDAY, null, 240)).toBe(0);
  });

  it('is not late even if the person did drop into the office', () => {
    expect(late(WEDNESDAY, '11:00')).toBe(0);
  });
});

describe('a day with no blocks at all', () => {
  it('is not a working day, so it cannot be late', () => {
    expect(late(FRIDAY, null)).toBe(0);
    expect(late(FRIDAY, '10:00', 120)).toBe(0);
  });
});

describe('an expected arrival the device missed', () => {
  it('falls back to the sheet rather than inventing a number', () => {
    expect(late(THURSDAY, null, 45)).toBe(45);
  });

  it('reads a missing figure as zero, not as absent', () => {
    expect(late(THURSDAY, null, 0)).toBe(0);
  });
});

describe('marked days still decide themselves', () => {
  const marked = (dayStatus: 'absent' | 'vacation') =>
    computeLateMinutes({
      date: WEDNESDAY,
      clockIn: null,
      sheetLateMinutes: 0,
      dayStatus,
      schedule: { workingDays: null, startTime: null, blocks: SCHEDULE },
    });

  it('counts an absent day as a full day, even a fully-online one', () => {
    // This is how "online hours are worked unless a manager says otherwise"
    // gets said: the manager marks the day.
    expect(marked('absent')).toBe(8 * 60);
  });

  it('never counts approved leave as lateness', () => {
    expect(marked('vacation')).toBe(0);
  });
});

describe('memberships without blocks are untouched', () => {
  const old = (date: string, clockIn: string | null, sheet = 0) =>
    computeLateMinutes({
      date,
      clockIn,
      sheetLateMinutes: sheet,
      schedule: { workingDays: [0, 1, 2, 3, 4], startTime: '09:00' },
    });

  it('still measures against the single start time', () => {
    expect(old(MONDAY, '09:30')).toBe(30);
  });

  it('still ignores a non-working day', () => {
    expect(old(FRIDAY, '11:00', 120)).toBe(0);
  });

  it('still falls back to the sheet when nothing is configured', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: null,
        sheetLateMinutes: 17,
        schedule: { workingDays: null, startTime: null },
      })
    ).toBe(17);
  });

  it('treats an empty block list as "no block schedule"', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '09:30',
        sheetLateMinutes: 0,
        schedule: { workingDays: [0, 1, 2, 3, 4], startTime: '09:00', blocks: [] },
      })
    ).toBe(30);
  });
});

describe('the week adds up', () => {
  it('gives each weekday its own hours', () => {
    expect(scheduledMinutes(SCHEDULE, SUN)).toBe(5 * 60);
    expect(scheduledMinutes(SCHEDULE, MON)).toBe(6 * 60);
    expect(scheduledMinutes(SCHEDULE, TUE)).toBe(5 * 60);
    expect(scheduledMinutes(SCHEDULE, WED)).toBe(6 * 60);
    expect(scheduledMinutes(SCHEDULE, THU)).toBe(3 * 60);
  });

  it('totals 25 hours a week', () => {
    const week = [SUN, MON, TUE, WED, THU].reduce(
      (sum, d) => sum + scheduledMinutes(SCHEDULE, d),
      0
    );
    expect(week).toBe(25 * 60);
  });

  it('splits 13 office and 12 online — not the 17 the paper claims', () => {
    const days = [SUN, MON, TUE, WED, THU];
    const office = days.reduce((s, d) => s + scheduledMinutes(SCHEDULE, d, 'office'), 0);
    const online = days.reduce((s, d) => s + scheduledMinutes(SCHEDULE, d, 'online'), 0);
    expect(office).toBe(13 * 60);
    expect(online).toBe(12 * 60);
    expect(office + online).toBe(25 * 60);
  });
});

describe('the primitives', () => {
  it('finds the first office start, ignoring online blocks', () => {
    expect(firstOfficeStartMinutes(SCHEDULE, SUN)).toBe(14 * 60 + 30);
    expect(firstOfficeStartMinutes(SCHEDULE, MON)).toBe(9 * 60);
  });

  it('returns null on a day that never reaches the office', () => {
    expect(firstOfficeStartMinutes(SCHEDULE, WED)).toBeNull();
  });

  it('takes the EARLIEST office block when a day has several', () => {
    const split: ScheduleBlock[] = [
      { weekday: MON, startTime: '14:00', endTime: '16:00', mode: 'office' },
      { weekday: MON, startTime: '09:00', endTime: '11:00', mode: 'office' },
    ];
    expect(firstOfficeStartMinutes(split, MON)).toBe(9 * 60);
  });

  it('knows which days are scheduled at all', () => {
    expect(hasAnyBlock(SCHEDULE, WED)).toBe(true);
    expect(hasAnyBlock(SCHEDULE, 5)).toBe(false);
  });
});


/**
 * TIMES DO NOT SURVIVE RTL ON THEIR OWN.
 *
 * A native <input type="time"> lays its own segments out right-to-left inside
 * an RTL page: 09:00 renders as "00:09" and 14:30 as "30:14". The stored value
 * is perfectly correct and the screen is unreadable — the schedule editor
 * shipped that way and read as nonsense.
 *
 * Two defences. A time input must be marked dir="ltr", per the house rule that
 * numbers, units and times stay LTR at render time; and where the value is an
 * hour of a working day, TimeOfDayPicker is better still — it is built from
 * selects, which do not reorder, and shows AM/PM instead of whatever 24-hour
 * format the operating system happens to pick.
 */
describe('time inputs in an RTL page', () => {
  it('uses no native <input type="time"> anywhere — the picker replaces them', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.tsx')) {
          const src = readFileSync(full, 'utf8');
          // Each JSX element opening a time input, up to its closing bracket.
          for (const m of src.matchAll(/<input[^>]*type="time"[\s\S]{0,400}?\/>/g)) {
            offenders.push(`${full}: ${m[0].slice(0, 60)}`);
          }
        }
      }
    };
    walk('components');
    expect(offenders).toEqual([]);
  });

  it('gives every time entry a 12-hour AM/PM face', () => {
    const picker = readFileSync('components/TimeOfDayPicker.tsx', 'utf8');
    // Three selects: 1-12, minutes, AM/PM — not a 24-hour field.
    expect(picker).toContain("{ length: 12 }");
    expect(picker).toContain("<option value=\"AM\">");
    expect(picker).toContain("<option value=\"PM\">");
    // Arabic gets ص/م, not the Latin abbreviations.
    expect(picker).toContain("ar ? 'ص' : 'AM'");
  });

  it('uses that picker on the attendance review table too', () => {
    const att = readFileSync('components/AttendanceView.tsx', 'utf8');
    expect(att).toContain('TimeOfDayPicker');
    expect(att).toMatch(/TimeOfDayPicker[\s\S]{0,200}?r\.clockIn/);
    expect(att).toMatch(/TimeOfDayPicker[\s\S]{0,200}?r\.clockOut/);
  });

  it('uses the AM/PM picker for the schedule intervals', () => {
    const src = readFileSync('components/EmployeesView.tsx', 'utf8');
    // The interval rows take startTime/endTime through the picker, so they
    // read as "9:00 AM" rather than as a reversed 24-hour string.
    expect(src).toMatch(/<TimeOfDayPicker[\s\S]{0,200}?value=\{b\.startTime\}/);
    expect(src).toMatch(/<TimeOfDayPicker[\s\S]{0,200}?value=\{b\.endTime\}/);
  });
});


/**
 * EVERY PLACE THAT SCORES LATENESS MUST SEE THE BLOCKS.
 *
 * This is the test I did not have, and its absence cost a real number. Blocks
 * were wired into the upload and into the employee's own summary, but NOT into
 * attendanceSummaryForCompany — the manager-facing one, which is the screen
 * anybody actually looks at. It recomputes on read, so it quietly went on
 * scoring a block-scheduled person against a start time that no longer meant
 * anything: 981 minutes of lateness on a term where 24 were real.
 *
 * Worse than the wrong start time was the working-days guard beside it. A
 * person's older working_days list disagrees with the week their blocks
 * describe, so whole days were skipped as "not a working day" while other days
 * were scored against nothing.
 *
 * Source-level, because the alternative is a database. What it pins is
 * structural and is exactly what went wrong: a call site that forgot.
 */
describe('every lateness call site is block-aware', () => {
  const src = readFileSync('lib/platform/attendance.ts', 'utf8');

  it('passes blocks at every computeLateMinutes call', () => {
    const calls = [...src.matchAll(/computeLateMinutes\(\{[\s\S]{0,600}?\}\)/g)].map(
      (m) => m[0]
    );
    // Four: the upload, the company summary, the employee's own summary, and
    // the objections review.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      // Either blocks are handed in directly, or via a schedule object built
      // just above that carries them.
      const mentionsBlocks =
        call.includes('blocks') ||
        /schedule: scheduleFor\(/.test(call) ||
        /schedule,/.test(call);
      expect(mentionsBlocks).toBe(true);
    }
  });

  it('builds a block lookup for each of the read paths', () => {
    // One per query, over the range being read — not one per row.
    const lookups = src.match(/scheduleBlockLookup\(/g) ?? [];
    expect(lookups.length).toBeGreaterThanOrEqual(4);
  });

  it('lets blocks decide the working day, not the older working_days list', () => {
    // The guard that skips a non-working day has to ask the blocks first,
    // or a day the person genuinely works is dropped from their totals.
    expect(src).toMatch(/blocks\.length > 0[\s\S]{0,120}?hasAnyBlock\(blocks, isoDateWeekday/);
  });
});
