import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSupabaseStub } from '../helpers/supabase';

/**
 * A task going overdue to WARN (orange) must notify the ASSIGNEE and the
 * task's APPROVER — the manager accountable for signing it off.
 *
 * Before this fix the second recipient was `created_by` (whoever created the
 * task), which was a safe stand-in for "a manager" only back when task
 * creation was manager/admin-only. Once an employee could be granted
 * 'tasks.create' (can_create_task), created_by stopped being guaranteed to be
 * a manager at all — an employee-created task going overdue would notify the
 * employee-creator a second time instead of alerting any actual manager.
 */

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/platform/colorEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/colorEngine')>();
  return { ...actual, fileColor: vi.fn() };
});
vi.mock('@/lib/platform/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/notifications')>();
  return { ...actual, insertNotifications: vi.fn() };
});
vi.mock('@/lib/platform/telegram', () => ({ sendTelegram: vi.fn() }));

const { getSupabaseAdmin } = await import('@/lib/supabase');
const { fileColor } = await import('@/lib/platform/colorEngine');
const { insertNotifications } = await import('@/lib/platform/notifications');
const { evaluateAlerts } = await import('@/lib/platform/alerts');

const COMPANY = 'company-a';
const ASSIGNEE_ID = 'assignee-1';
const APPROVER_ID = 'approver-1';
const EMPLOYEE_CREATOR_ID = 'employee-creator-1';

function stubDb() {
  const stub = makeSupabaseStub((q) => {
    if (q.table === 'companies') {
      return {
        data: {
          name_en: 'Firm',
          name_ar: 'مكتب',
          alerts_enabled: true,
          telegram_enabled: false,
          working_days: [0, 1, 2, 3, 4],
          days_per_color_step: 3,
        },
      };
    }
    if (q.table === 'files') {
      return { data: [{ id: 'file-1', section: 'active', client: 'Ali', opponent: 'Sara' }] };
    }
    if (q.table === 'tasks') {
      // update() calls (stamping last_alert_level) land here too — only the
      // initial select needs task rows; updates resolve with no data either way.
      return {
        data: [
          {
            id: 'task-1',
            file_id: 'file-1',
            title: 'Draft the claim',
            assignee_id: ASSIGNEE_ID,
            approver_id: APPROVER_ID,
            status: 'open',
            accumulated_working_seconds: 0,
            last_resumed_at: new Date().toISOString(),
            assigned_at: new Date().toISOString(),
            last_alert_level: null,
          },
        ],
      };
    }
    return { data: null };
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fileColor).mockReturnValue({
    colorKey: 'orange',
    hex: '#f0a',
    stepIndex: 1,
    ladderLength: 3,
    alertLevel: 'warn',
    overdueSteps: 1,
  });
});

describe('evaluateAlerts — WARN notification recipients', () => {
  it('notifies the assignee and the approver, never a bystander creator', async () => {
    stubDb();
    await evaluateAlerts(COMPANY);

    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(insertNotifications).mock.calls[0][0];
    const recipientIds = rows.map((r) => r.userId).sort();
    expect(recipientIds).toEqual([APPROVER_ID, ASSIGNEE_ID].sort());
    expect(recipientIds).not.toContain(EMPLOYEE_CREATOR_ID);
    for (const r of rows) {
      expect(r.type).toBe('overdue_warn');
    }
  });

  it('does not double-notify when the assignee is also the approver', async () => {
    const stub = makeSupabaseStub((q) => {
      if (q.table === 'companies') {
        return {
          data: {
            name_en: 'Firm',
            name_ar: 'مكتب',
            alerts_enabled: true,
            telegram_enabled: false,
            working_days: [0, 1, 2, 3, 4],
            days_per_color_step: 3,
          },
        };
      }
      if (q.table === 'files') {
        return { data: [{ id: 'file-1', section: 'active', client: 'Ali', opponent: 'Sara' }] };
      }
      if (q.table === 'tasks') {
        return {
          data: [
            {
              id: 'task-1',
              file_id: 'file-1',
              title: 'Draft the claim',
              assignee_id: ASSIGNEE_ID,
              approver_id: ASSIGNEE_ID,
              status: 'open',
              accumulated_working_seconds: 0,
              last_resumed_at: new Date().toISOString(),
              assigned_at: new Date().toISOString(),
              last_alert_level: null,
            },
          ],
        };
      }
      return { data: null };
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(stub.client as never);

    await evaluateAlerts(COMPANY);

    const rows = vi.mocked(insertNotifications).mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ASSIGNEE_ID);
  });
});
