import { describe, expect, it } from 'vitest';
import {
  ABSENT_LATE_MINUTES,
  computeLateMinutes,
  isDayStatus,
  isoDateWeekday,
  timeToMinutes,
  type WorkSchedule,
} from '@/lib/platform/lateness';

/**
 * Lateness is now measured against the employee's OWN configured start time and
 * working days, rather than taken from the uploaded sheet's "Late In(M)".
 *
 * Calendar anchors used below (all 2026):
 *   Sun 2026-08-02, Mon 2026-08-03, Fri 2026-08-07, Sat 2026-08-08
 */

const SUNDAY = '2026-08-02';
const MONDAY = '2026-08-03';
const FRIDAY = '2026-08-07';

const GULF_WEEK = [0, 1, 2, 3, 4]; // Sun–Thu

const schedule = (over: Partial<WorkSchedule> = {}): WorkSchedule => ({
  workingDays: GULF_WEEK,
  startTime: '08:00',
  ...over,
});

describe('isoDateWeekday', () => {
  it('maps dates to 0=Sunday..6=Saturday', () => {
    expect(isoDateWeekday(SUNDAY)).toBe(0);
    expect(isoDateWeekday(MONDAY)).toBe(1);
    expect(isoDateWeekday(FRIDAY)).toBe(5);
    expect(isoDateWeekday('2026-08-08')).toBe(6);
  });
});

describe('timeToMinutes', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(timeToMinutes('08:00')).toBe(480);
    expect(timeToMinutes('08:30:45')).toBe(510);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('returns null for anything unusable, so callers can fall back', () => {
    expect(timeToMinutes(null)).toBeNull();
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes('not a time')).toBeNull();
    expect(timeToMinutes('25:00')).toBeNull();
    expect(timeToMinutes('08:71')).toBeNull();
  });
});

describe('computeLateMinutes — measured against the configured start time', () => {
  it('counts minutes past the start time', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:17',
        sheetLateMinutes: 999, // must be ignored
        schedule: schedule(),
      })
    ).toBe(17);
  });

  it('ignores the sheet value entirely once a start time is set', () => {
    // The whole point of the feature: the device's own Late In(M) no longer
    // decides anything for a configured employee.
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:05',
        sheetLateMinutes: 60,
        schedule: schedule(),
      })
    ).toBe(5);
  });

  it('treats arriving early as zero, never negative', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '07:31',
        sheetLateMinutes: 0,
        schedule: schedule(),
      })
    ).toBe(0);
  });

  it('treats arriving exactly on time as zero', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:00:00',
        sheetLateMinutes: 0,
        schedule: schedule(),
      })
    ).toBe(0);
  });

  it('honours a different start time per employee', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '09:10',
        sheetLateMinutes: 0,
        schedule: schedule({ startTime: '09:00' }),
      })
    ).toBe(10);
  });

  it('handles seconds on the clock-in without rounding up', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:09:59',
        sheetLateMinutes: 0,
        schedule: schedule(),
      })
    ).toBe(9);
  });
});

describe('computeLateMinutes — working days', () => {
  it('is zero on a day the employee does not work', () => {
    // Friday is not in Sun–Thu, so a late arrival cannot be late.
    expect(
      computeLateMinutes({
        date: FRIDAY,
        clockIn: '11:00',
        sheetLateMinutes: 180,
        schedule: schedule(),
      })
    ).toBe(0);
  });

  it('counts normally on a day the employee does work', () => {
    expect(
      computeLateMinutes({
        date: SUNDAY,
        clockIn: '08:20',
        sheetLateMinutes: 0,
        schedule: schedule(),
      })
    ).toBe(20);
  });

  it('treats an employee with no configured days as working every day', () => {
    // Preserves the pre-feature behaviour for anyone not yet configured.
    expect(
      computeLateMinutes({
        date: FRIDAY,
        clockIn: '08:30',
        sheetLateMinutes: 0,
        schedule: schedule({ workingDays: null }),
      })
    ).toBe(30);
  });

  it('treats an empty working-days array the same as unset', () => {
    expect(
      computeLateMinutes({
        date: FRIDAY,
        clockIn: '08:30',
        sheetLateMinutes: 0,
        schedule: schedule({ workingDays: [] }),
      })
    ).toBe(30);
  });
});

describe('computeLateMinutes — falls back to the sheet when it cannot measure', () => {
  it('uses the sheet value when no start time is configured', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:40',
        sheetLateMinutes: 40,
        schedule: schedule({ startTime: null }),
      })
    ).toBe(40);
  });

  it('uses the sheet value when the device recorded no clock-in', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: null,
        sheetLateMinutes: 25,
        schedule: schedule(),
      })
    ).toBe(25);
  });

  it('still returns 0 on a non-working day even with no start time', () => {
    // The day check comes first, so an unconfigured start time cannot
    // resurrect a sheet value on a day off.
    expect(
      computeLateMinutes({
        date: FRIDAY,
        clockIn: null,
        sheetLateMinutes: 90,
        schedule: schedule({ startTime: null }),
      })
    ).toBe(0);
  });

  it('never returns a negative or non-finite fallback', () => {
    const bad = { date: MONDAY, clockIn: null, schedule: schedule({ startTime: null }) };
    expect(computeLateMinutes({ ...bad, sheetLateMinutes: -5 })).toBe(0);
    expect(computeLateMinutes({ ...bad, sheetLateMinutes: Number.NaN })).toBe(0);
  });

  it('rounds a fractional sheet value to whole minutes', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: null,
        sheetLateMinutes: 12.6,
        schedule: schedule({ startTime: null }),
      })
    ).toBe(13);
  });
});

describe('computeLateMinutes — absent / vacation (migration #25)', () => {
  it('scores an absent day as a full working day late (8 hours)', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: null,
        sheetLateMinutes: 0,
        schedule: schedule(),
        dayStatus: 'absent',
      })
    ).toBe(ABSENT_LATE_MINUTES);
    expect(ABSENT_LATE_MINUTES).toBe(480);
  });

  it('scores a vacation day as zero', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: null,
        sheetLateMinutes: 0,
        schedule: schedule(),
        dayStatus: 'vacation',
      })
    ).toBe(0);
  });

  it('lets the mark override whatever the device recorded', () => {
    // Someone marked absent who nonetheless has a clock-in on the sheet is
    // still absent — the human mark wins.
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '08:05',
        sheetLateMinutes: 5,
        schedule: schedule(),
        dayStatus: 'absent',
      })
    ).toBe(ABSENT_LATE_MINUTES);
  });

  it('vacation wins even on a heavily late day', () => {
    expect(
      computeLateMinutes({
        date: MONDAY,
        clockIn: '13:00',
        sheetLateMinutes: 300,
        schedule: schedule(),
        dayStatus: 'vacation',
      })
    ).toBe(0);
  });

  it('applies the mark even on a NON-working day', () => {
    // The mark is deliberately checked before the working-day test, so
    // marking someone absent is never silently discarded.
    expect(
      computeLateMinutes({
        date: FRIDAY,
        clockIn: null,
        sheetLateMinutes: 0,
        schedule: schedule(),
        dayStatus: 'absent',
      })
    ).toBe(ABSENT_LATE_MINUTES);
  });

  it("treats 'present', null and undefined identically", () => {
    const base = {
      date: MONDAY,
      clockIn: '08:17',
      sheetLateMinutes: 0,
      schedule: schedule(),
    };
    expect(computeLateMinutes({ ...base, dayStatus: 'present' })).toBe(17);
    expect(computeLateMinutes({ ...base, dayStatus: null })).toBe(17);
    expect(computeLateMinutes(base)).toBe(17);
  });
});

describe('isDayStatus', () => {
  it('accepts only the three known statuses', () => {
    expect(isDayStatus('present')).toBe(true);
    expect(isDayStatus('absent')).toBe(true);
    expect(isDayStatus('vacation')).toBe(true);
    expect(isDayStatus('holiday')).toBe(false);
    expect(isDayStatus(null)).toBe(false);
    expect(isDayStatus(undefined)).toBe(false);
  });
});
