import { describe, expect, it } from 'vitest';
import {
  CLOSED_SECTIONS,
  isClosedSection,
  fileColor,
  type ColorCompanySettings,
  type ColorTask,
} from '@/lib/platform/colorEngine';
import { computeTaskCountdown } from '@/components/taskCountdownEngine';

/**
 * A folder moved to ATTRITION (client left / contract ended early) is finished.
 * Its tasks are KEPT for the record, but they stop counting: no clock runs,
 * nothing goes overdue, and nothing reads as "in progress".
 *
 * The colour engine already treated attrition as closed. The live countdown in
 * the browser did not — it only stopped for 'expired' — so a written-off folder
 * kept ticking. Both now share isClosedSection() so they cannot drift again.
 */

const SETTINGS: ColorCompanySettings = {
  workingDays: [0, 1, 2, 3, 4],
  daysPerColorStep: 3,
};

const NOW = new Date('2026-08-03T12:00:00Z');

/** A task left running for a long time — badly overdue if anything counted it. */
const LONG_RUNNING: ColorTask = {
  status: 'open',
  accumulatedWorkingSeconds: 60 * 60 * 24 * 40,
  lastResumedAt: '2026-06-01T08:00:00Z',
  assignedAt: '2026-06-01T08:00:00Z',
};

describe('isClosedSection', () => {
  it('treats expired and attrition as closed', () => {
    expect(isClosedSection('expired')).toBe(true);
    expect(isClosedSection('attrition')).toBe(true);
  });

  it('treats potential and active as open', () => {
    expect(isClosedSection('potential')).toBe(false);
    expect(isClosedSection('active')).toBe(false);
  });

  it('exposes exactly those two as the shared list', () => {
    expect([...CLOSED_SECTIONS].sort()).toEqual(['attrition', 'expired']);
  });
});

describe('fileColor — attrition never goes overdue', () => {
  it('raises no alert however overdue the task is', () => {
    const color = fileColor({ section: 'attrition' }, [LONG_RUNNING], SETTINGS, NOW);

    expect(color.alertLevel).toBe('none');
  });

  it('keeps its fixed colour instead of climbing the ladder', () => {
    const color = fileColor({ section: 'attrition' }, [LONG_RUNNING], SETTINGS, NOW);

    expect(color.stepIndex).toBe(0);
    expect(color.colorKey).toBe('dgray');
  });

  it('by contrast, an ACTIVE folder with the same task does go red', () => {
    // Proves the fixture really is overdue — otherwise the assertions above
    // would pass for the wrong reason.
    const color = fileColor({ section: 'active' }, [LONG_RUNNING], SETTINGS, NOW);

    expect(color.alertLevel).not.toBe('none');
  });
});

describe('computeTaskCountdown — attrition stops the clock', () => {
  const countdown = (section: 'active' | 'expired' | 'attrition') =>
    computeTaskCountdown(
      {
        status: 'open',
        accumulatedWorkingSeconds: LONG_RUNNING.accumulatedWorkingSeconds,
        lastResumedAt: LONG_RUNNING.lastResumedAt,
        assignedAt: LONG_RUNNING.assignedAt,
      },
      section,
      SETTINGS.workingDays,
      SETTINGS.daysPerColorStep,
      NOW
    );

  it('reports "done" for an attrition folder, not a running countdown', () => {
    expect(countdown('attrition')?.state).toBe('done');
  });

  it('counts no overdue days for an attrition folder', () => {
    expect(countdown('attrition')?.overdueWorkingDays).toBe(0);
    expect(countdown('attrition')?.remainingSeconds).toBeNull();
  });

  it('shows the attrition colour rather than green', () => {
    // Attrition is a loss, expired is a clean close — they should not look
    // identical just because both are finished.
    expect(countdown('attrition')?.currentColorKey).toBe('dgray');
    expect(countdown('expired')?.currentColorKey).toBe('green');
  });

  it('still ticks for an ACTIVE folder', () => {
    const active = countdown('active');

    expect(active?.state).not.toBe('done');
    expect(active?.overdueWorkingDays).toBeGreaterThan(0);
  });
});
