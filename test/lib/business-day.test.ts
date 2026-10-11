import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TIME_ZONE,
  businessDateParts,
  shiftIsoDate,
  todayIso,
} from '@/lib/platform/businessDay';
import { currentAttendancePeriod } from '@/lib/platform/attendance';

/**
 * Qatar is UTC+3, so between local midnight and 03:00 the UTC date is still
 * yesterday. Every "what day is it" answer in the portal has to be the firm's
 * day, not UTC — otherwise leave, the attendance period and "before today" are
 * all a day out for three hours, every day.
 *
 * 21:00Z is exactly local midnight, which makes it the boundary worth pinning.
 */

const LATE_EVENING_UTC = new Date('2026-08-08T22:30:00Z'); // 01:30 local, 9th
const MIDDAY_UTC = new Date('2026-08-09T09:00:00Z'); // 12:00 local, 9th
const LAST_LOCAL_MINUTE = new Date('2026-08-09T20:59:00Z'); // 23:59 local, 9th
const LOCAL_MIDNIGHT = new Date('2026-08-09T21:00:00Z'); // 00:00 local, 10th

describe('todayIso', () => {
  it('names Qatar as the firm’s zone', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Qatar');
  });

  it('reports the local day when UTC is still on the previous one', () => {
    expect(todayIso(LATE_EVENING_UTC)).toBe('2026-08-09');
  });

  it('agrees with UTC through the rest of the day', () => {
    expect(todayIso(MIDDAY_UTC)).toBe('2026-08-09');
  });

  it('does not roll over early', () => {
    expect(todayIso(LAST_LOCAL_MINUTE)).toBe('2026-08-09');
  });

  it('rolls over exactly at local midnight', () => {
    expect(todayIso(LOCAL_MIDNIGHT)).toBe('2026-08-10');
  });
});

describe('businessDateParts', () => {
  it('splits the firm’s day into numeric parts, month 1-based', () => {
    expect(businessDateParts(LATE_EVENING_UTC)).toEqual({
      year: 2026,
      month: 8,
      day: 9,
    });
  });
});

describe('shiftIsoDate', () => {
  it('shifts whole days without drifting', () => {
    expect(shiftIsoDate('2026-08-09', 1)).toBe('2026-08-10');
    expect(shiftIsoDate('2026-08-09', -1)).toBe('2026-08-08');
    expect(shiftIsoDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('currentAttendancePeriod — the 25th→25th boundary', () => {
  it('does not flip a day late just after local midnight on the 25th', () => {
    // 21:30Z on the 24th is 00:30 local on the 25th: the NEW period has begun.
    const justAfterLocalMidnight = new Date('2026-08-24T21:30:00Z');
    expect(currentAttendancePeriod(justAfterLocalMidnight)).toEqual({
      start: '2026-08-25',
      end: '2026-09-25',
    });
  });

  it('still reports the old period in the last local minute of the 24th', () => {
    // 20:59Z on the 24th is 23:59 local on the 24th.
    const lastMinuteOf24th = new Date('2026-08-24T20:59:00Z');
    expect(currentAttendancePeriod(lastMinuteOf24th)).toEqual({
      start: '2026-07-25',
      end: '2026-08-25',
    });
  });

  it('reports the containing period mid-month', () => {
    expect(currentAttendancePeriod(MIDDAY_UTC)).toEqual({
      start: '2026-07-25',
      end: '2026-08-25',
    });
  });

  it('handles a year boundary', () => {
    // 00:30 local on 1 Jan 2027 → the period that began 25 Dec 2026.
    expect(currentAttendancePeriod(new Date('2026-12-31T21:30:00Z'))).toEqual({
      start: '2026-12-25',
      end: '2027-01-25',
    });
  });
});
