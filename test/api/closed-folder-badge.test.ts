import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * Regression: a folder written off to ATTRITION stopped its countdown, but the
 * folder card kept showing an open-task number in grid view — so a closed
 * matter still looked like it had work in progress.
 *
 * The count is zeroed in mapRow (lib/platform/files.ts), which every view is
 * built from, so grid / list / kanban cannot disagree. This exercises the
 * REAL path — getFileById → mapRow — rather than restating the rule.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/tasks', () => ({
  openTasksForColorByFile: vi.fn(),
  ACTIVE_TASK_STATUSES: ['open', 'awaiting_approval'],
}));
vi.mock('@/lib/platform/folderTypes', () => ({
  folderTypeLayoutsByKey: vi.fn(async () => new Map([['case', 'case']])),
  getFolderTypeByKey: vi.fn(),
}));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { openTasksForColorByFile } = await import('@/lib/platform/tasks');
const { getFileById } = await import('@/lib/platform/files');

const FILE_ID = 'file-1';

/** Two genuinely unfinished tasks — enough to badge an open folder. */
const UNFINISHED = [
  {
    status: 'open',
    accumulatedWorkingSeconds: 3600,
    lastResumedAt: '2026-08-01T08:00:00Z',
    assignedAt: '2026-08-01T08:00:00Z',
  },
  {
    status: 'awaiting_approval',
    accumulatedWorkingSeconds: 7200,
    lastResumedAt: null,
    assignedAt: '2026-08-01T08:00:00Z',
  },
];

function stubFile(section: string) {
  const stub = makeSupabaseStub((q) => {
    if (q.table === 'files') {
      return {
        data: {
          id: FILE_ID,
          company_id: 'c1',
          client: 'Acme',
          opponent: 'Rival',
          managing_lawyer: 'Jassim',
          drive_link: null,
          section,
          created_by: 'u1',
          created_at: '2026-07-01T00:00:00Z',
          client_contact_id: null,
          opponent_en: 'Rival',
          opponent_ar: 'خصم',
          folder_leader_id: null,
          folder_type: 'case',
        },
      };
    }
    if (q.table === 'companies') {
      return { data: { working_days: [0, 1, 2, 3, 4], days_per_color_step: 3 } };
    }
    return { data: [] };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openTasksForColorByFile).mockResolvedValue(
    new Map([[FILE_ID, UNFINISHED]]) as never
  );
});

describe('openTaskCount by section', () => {
  it('is ZERO for an attrition folder despite unfinished tasks', async () => {
    stubFile('attrition');

    const file = await getFileById(FILE_ID);

    expect(file?.section).toBe('attrition');
    expect(file?.openTaskCount).toBe(0);
  });

  it('is ZERO for an expired folder too', async () => {
    stubFile('expired');

    expect((await getFileById(FILE_ID))?.openTaskCount).toBe(0);
  });

  it('still counts on an ACTIVE folder', async () => {
    // Proves the fixture really does carry unfinished tasks — otherwise the
    // two assertions above would pass for the wrong reason.
    stubFile('active');

    expect((await getFileById(FILE_ID))?.openTaskCount).toBe(2);
  });

  it('still counts on a POTENTIAL folder', async () => {
    stubFile('potential');

    expect((await getFileById(FILE_ID))?.openTaskCount).toBe(2);
  });

  it('gives an attrition folder its own colour, not green', async () => {
    // A loss should not be indistinguishable from a clean close.
    stubFile('attrition');
    const attrition = await getFileById(FILE_ID);
    stubFile('expired');
    const expired = await getFileById(FILE_ID);

    expect(attrition?.color.colorKey).toBe('dgray');
    expect(expired?.color.colorKey).toBe('green');
    expect(attrition?.color.alertLevel).toBe('none');
  });
});
