'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useDash } from './DashboardShell';
import ManageFolderTypesModal from './ManageFolderTypesModal';

interface Settings {
  working_days: number[];
  days_per_color_step: number;
  telegram_bot_token: string;
  telegram_chat_id: string;
  alerts_enabled: boolean;
  telegram_enabled: boolean;
  /** The one manager who decides attendance objections. Null = nobody has
   * been designated, and the objection button on the upload review table
   * stays disabled. */
  attendance_objection_approver_id: string | null;
  /** The one manager who signs off every approval-gated action. '' = none. */
  approval_manager_id: string;
}

/** A manager of this company — the choices for BOTH approver dropdowns. */
interface ManagerOption {
  userId: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
  username: string;
}

/** How a manager is named in either approver dropdown. */
function managerLabel(m: ManagerOption, ar: boolean): string {
  return (
    (ar ? m.fullNameAr : m.fullNameEn) || m.fullNameEn || m.fullNameAr || m.username
  );
}

const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];
const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export default function SettingsView() {
  const { t, lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';
  const canEdit = activeCompany?.role === 'admin';
  const isAdminOrManager =
    activeCompany?.role === 'admin' || activeCompany?.isManager === true;

  // 'company.folderTypes' has no legacy boolean — only an admin/manager
  // baseline plus this capability-tree grant unlock "Manage folder types".
  const [folderTypesGrant, setFolderTypesGrant] = useState(false);
  useEffect(() => {
    if (!companyId || isAdminOrManager) {
      setFolderTypesGrant(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/permissions/me`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          capabilities?: string[];
        };
        if (!cancelled && res.ok && data.ok && Array.isArray(data.capabilities)) {
          setFolderTypesGrant(data.capabilities.includes('company.folderTypes'));
        }
      } catch {
        /* keep false */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, isAdminOrManager]);

  const canManageFolderTypes = isAdminOrManager || folderTypesGrant;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showManageTypes, setShowManageTypes] = useState(false);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  /** The assigned approving manager when they are NOT in `managers` — they
   * stopped being a manager but the assignment (rightly) outlived that. */
  const [missingApprovalManager, setMissingApprovalManager] =
    useState<ManagerOption | null>(null);
  /** Set only by the admin actually choosing "— Nobody —". The server clears
   * on this flag alone, so a dropdown that merely failed to render its holder
   * can no longer unassign anyone. */
  const [clearApprovalManager, setClearApprovalManager] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/settings`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'load failed');
      setSettings(data.settings as Settings);
      setManagers(Array.isArray(data.managers) ? (data.managers as ManagerOption[]) : []);
      setMissingApprovalManager(
        (data.approval_manager_missing as ManagerOption | null) ?? null
      );
      setClearApprovalManager(false);
    } catch {
      setError(ar ? 'تعذّر تحميل الإعدادات.' : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [companyId, ar]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleDay(d: number) {
    if (!canEdit || !settings) return;
    setSaved(false);
    const has = settings.working_days.includes(d);
    const next = has
      ? settings.working_days.filter((x) => x !== d)
      : [...settings.working_days, d].sort((a, b) => a - b);
    if (next.length === 0) return; // keep at least one working day
    setSettings({ ...settings, working_days: next });
  }

  function setStep(v: number) {
    if (!canEdit || !settings) return;
    setSaved(false);
    const n = Math.max(1, Math.floor(Number.isFinite(v) ? v : 1));
    setSettings({ ...settings, days_per_color_step: n });
  }

  function setAlertsEnabled(v: boolean) {
    if (!canEdit || !settings) return;
    setSaved(false);
    setSettings({ ...settings, alerts_enabled: v });
  }

  function setTelegramEnabled(v: boolean) {
    if (!canEdit || !settings) return;
    setSaved(false);
    setSettings({ ...settings, telegram_enabled: v });
  }

  function setObjectionApprover(v: string) {
    if (!canEdit || !settings) return;
    setSaved(false);
    setSettings({ ...settings, attendance_objection_approver_id: v || null });
  }

  function setApprovalManager(v: string) {
    if (!canEdit || !settings) return;
    setSaved(false);
    // Choosing "— Nobody —" is the ONE thing that unassigns. Recording it as a
    // separate flag is what distinguishes it from an empty value the form
    // produced on its own.
    setClearApprovalManager(v === '');
    setSettings({ ...settings, approval_manager_id: v });
  }

  async function save() {
    if (!canEdit || !settings || !companyId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          // Only a deliberate "— Nobody —" carries the clear. Without this the
          // server leaves the current assignment exactly where it is.
          approval_manager_clear: clearApprovalManager,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'save failed');
      // A partial save: everything stored except the approving manager, because
      // its column isn't in the database yet. Reporting a plain "Saved" would
      // leave the admin believing gated permissions are ready to use when
      // nothing can approve them.
      if (data.warning === 'not_migrated' && data.error) {
        setError(data.error);
        setSaved(false);
        return;
      }
      setSaved(true);
    } catch {
      setError(ar ? 'تعذّر الحفظ.' : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const card: CSSProperties = {
    background: 'var(--surface-card, #fff)',
    border: '1px solid var(--border, #E9E7E0)',
    borderRadius: 12,
    padding: 20,
    marginBlockEnd: 16,
  };
  const eyebrow: CSSProperties = {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--text-muted, #93908A)',
    marginBlockEnd: 8,
    fontWeight: 600,
  };
  const help: CSSProperties = {
    fontSize: 12.5,
    color: 'var(--text-muted, #93908A)',
    marginBlockStart: 6,
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary, #232220)', margin: 0 }}>
        {ar ? 'الإعدادات' : 'Settings'}
      </h1>
      <p style={{ color: 'var(--text-muted, #93908A)', marginBlockStart: 4, marginBlockEnd: 20 }}>
        {activeCompany
          ? (ar ? activeCompany.nameAr : activeCompany.nameEn)
          : ''}
      </p>

      {canManageFolderTypes && (
        <div style={card}>
          <div style={eyebrow}>{ar ? 'أنواع الملفات' : 'Folder types'}</div>
          <button
            type="button"
            className="dash-btn-ghost"
            onClick={() => setShowManageTypes(true)}
          >
            {t.manageFolderTypes}
          </button>
          <div style={help}>
            {ar
              ? 'إضافة أنواع ملفات مخصّصة بعرض جانب النوعين الأساسيين (قضية وعقد).'
              : 'Add custom folder types alongside the two built-in ones (case and contract).'}
          </div>
        </div>
      )}

      {!canEdit && (
        <div
          style={{
            ...card,
            background: 'var(--bg-cell, #F3F2ED)',
            fontSize: 13.5,
            color: 'var(--text-muted, #93908A)',
          }}
        >
          {ar
            ? 'يمكن للمشرف فقط تغيير الإعدادات.'
            : 'Only an admin can change settings.'}
        </div>
      )}

      {loading && (
        <div style={{ color: 'var(--text-muted, #93908A)' }}>
          {ar ? 'جارٍ التحميل…' : 'Loading…'}
        </div>
      )}

      {error && (
        <div
          style={{
            ...card,
            borderColor: '#e0b4ae',
            background: '#fbeae8',
            color: '#9a3b2f',
            fontSize: 13.5,
          }}
        >
          {error}
        </div>
      )}

      {settings && !loading && (
        <>
          {/* Days per color step */}
          <div style={card}>
            <div style={eyebrow}>
              {ar ? 'أيام العمل لكل خطوة لون' : 'Working days per color step'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                disabled={!canEdit || settings.days_per_color_step <= 1}
                onClick={() => setStep(settings.days_per_color_step - 1)}
                style={stepBtn(!canEdit || settings.days_per_color_step <= 1)}
                aria-label={ar ? 'إنقاص' : 'Decrease'}
              >
                −
              </button>
              <span
                dir="ltr"
                style={{ fontSize: 24, fontWeight: 700, minWidth: 36, textAlign: 'center', color: 'var(--text-primary, #232220)' }}
              >
                {settings.days_per_color_step}
              </span>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => setStep(settings.days_per_color_step + 1)}
                style={stepBtn(!canEdit)}
                aria-label={ar ? 'زيادة' : 'Increase'}
              >
                +
              </button>
            </div>
            <div style={help}>
              {ar
                ? 'عدد أيام العمل التي يتقدّم بعدها لون الملف خطوة واحدة (أصفر ← برتقالي ← أحمر).'
                : 'How many working days of overdue advance a file one color step (yellow → orange → red).'}
            </div>
          </div>

          {/* Working days */}
          <div style={card}>
            <div style={eyebrow}>{ar ? 'أيام العمل' : 'Working days'}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {DAY_ORDER.map((d) => {
                const on = settings.working_days.includes(d);
                const label = (ar ? DAY_LABELS_AR : DAY_LABELS_EN)[d];
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => toggleDay(d)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border, #E9E7E0)',
                      cursor: canEdit ? 'pointer' : 'default',
                      fontSize: 13.5,
                      fontWeight: on ? 700 : 500,
                      background: on ? 'var(--albaker-gold, #BD9446)' : 'var(--bg-cell, #F3F2ED)',
                      color: on ? '#fff' : 'var(--text-muted, #93908A)',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div style={help}>
              {ar
                ? 'الأيام التي تُحتسب كأيام عمل؛ عطلات نهاية الأسبوع لا تُحرّك العدّاد.'
                : 'Days that count as working days; weekends do not advance the timer.'}
            </div>
          </div>

          {/* Attendance objections — who decides them */}
          <div style={card}>
            <div style={eyebrow}>{ar ? 'اعتراضات الحضور' : 'Attendance objections'}</div>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                marginBlockEnd: 6,
                color: 'var(--text-primary, #232220)',
              }}
              htmlFor="objection-approver"
            >
              {ar ? 'المدير المسؤول عن الاعتراضات' : 'Objection approver'}
            </label>
            <select
              id="objection-approver"
              disabled={!canEdit}
              value={settings.attendance_objection_approver_id ?? ''}
              onChange={(e) => setObjectionApprover(e.target.value)}
              style={inputStyle}
            >
              <option value="">{ar ? '— لا أحد —' : '— Nobody —'}</option>
              {managers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {managerLabel(m, ar)}
                </option>
              ))}
            </select>
            <div style={help}>
              {ar
                ? 'عند رفع كشف الحضور، يمكن لمن يملك صلاحية الاعتراض طلب خصم وقت من يوم معيّن. يذهب الطلب إلى هذا المدير وحده، فيوافق (فيُخصم الوقت) أو يرفض (فتبقى الدقائق كما هي). بدون تحديد مدير هنا، لا يمكن إرسال أي اعتراض.'
                : 'When the attendance sheet is uploaded, whoever holds the objection permission can ask for time to be removed from a day. The request goes to this manager alone, who approves it (the time is deducted) or rejects it (the minutes stand). With nobody set here, no objection can be sent.'}
            </div>
          </div>

          {/* Capability approvals — who signs off a gated permission. A
              SEPARATE assignment from the objection approver above: the same
              person may hold both, but they decide different things. Assigned
              by an ADMIN on purpose, since whoever hands out a gated permission
              must not also get to pick who polices its use. */}
          <div style={card}>
            <div style={eyebrow}>{ar ? 'المدير المعتمد' : 'Approving manager'}</div>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                marginBlockEnd: 6,
                color: 'var(--text-primary, #232220)',
              }}
              htmlFor="approval-manager"
            >
              {ar ? 'المدير الذي يوافق على الإجراءات' : 'Approves gated actions'}
            </label>
            <select
              id="approval-manager"
              disabled={!canEdit}
              value={settings.approval_manager_id}
              onChange={(e) => setApprovalManager(e.target.value)}
              style={inputStyle}
            >
              <option value="">{ar ? '— لا أحد —' : '— Nobody —'}</option>
              {managers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {managerLabel(m, ar)}
                </option>
              ))}
              {/* The assigned holder, when they are no longer a manager and
                  so no longer in the list above. Without this option the
                  <select> has nothing matching its value and falls back to
                  showing "— Nobody —" — which reads as "unassigned" when it
                  is not, and is how the assignment appeared to change itself. */}
              {missingApprovalManager && (
                <option value={missingApprovalManager.userId}>
                  {managerLabel(missingApprovalManager, ar)}
                  {ar ? ' — لم يعد مديرًا' : ' — no longer a manager'}
                </option>
              )}
            </select>
            <div style={help}>
              {ar
                ? 'عندما تُمنح صلاحية بصيغة «تتطلب موافقة»، يذهب كل استخدام لها إلى هذا المدير، ولا يُنفَّذ الإجراء قبل موافقته. إن لم يُعيَّن أحد، تُرفض تلك الإجراءات بدل تنفيذها.'
                : 'When a permission is granted as "requires approval", every use of it goes to this manager and nothing happens until they approve. With nobody assigned, those actions are refused rather than let through.'}
            </div>
            {canEdit && !settings.approval_manager_id && (
              <div style={{ ...help, color: 'var(--albaker-gold, #BD9446)' }}>
                {ar
                  ? 'تنبيه: لا يمكن تنفيذ أي صلاحية «تتطلب موافقة» حتى تُعيّن مديرًا هنا.'
                  : 'Heads up: no "requires approval" permission can be used until you assign someone here.'}
              </div>
            )}
            {/* Assigned, but to somebody who has since stopped being a
                manager. The assignment stands — only an admin may move it — so
                this says what happened and leaves the choice to them. */}
            {canEdit && missingApprovalManager && (
              <div style={{ ...help, color: 'var(--albaker-gold, #BD9446)' }}>
                {ar
                  ? 'لا يزال هذا الشخص هو المعتمِد، لكنه لم يعد مديرًا في هذه الشركة. تبقى الصلاحية له حتى تختار شخصًا آخر أو «لا أحد».'
                  : 'This person still approves, but is no longer a manager of this company. The assignment stands until you pick someone else or "— Nobody —".'}
              </div>
            )}
          </div>

          {/* In-app alerts (master switch) */}
          <div style={card}>
            <div style={eyebrow}>{ar ? 'التنبيهات' : 'Alerts'}</div>
            <ToggleRow
              on={settings.alerts_enabled}
              disabled={!canEdit}
              onChange={setAlertsEnabled}
              title={ar ? 'تفعيل التنبيهات داخل التطبيق' : 'Enable in-app alerts'}
              ar={ar}
            />
            <div style={help}>
              {ar
                ? 'عند التفعيل، يتلقّى الموظفون والمدراء تنبيهات داخل التطبيق عند تأخّر المهام (برتقالي/أحمر)، وعند وضع علامة إنجاز أو إعادة مهمة. عند الإيقاف، لا يُرسَل أي تنبيه لهذه الشركة.'
                : 'When on, employees and managers get in-app notifications for overdue tasks (orange/red), task-done and send-back events. When off, nothing is notified for this company.'}
            </div>
          </div>

          {/* Telegram */}
          <div style={card}>
            <div style={eyebrow}>{ar ? 'تيليجرام' : 'Telegram'}</div>
            <ToggleRow
              on={settings.telegram_enabled}
              disabled={!canEdit}
              onChange={setTelegramEnabled}
              title={ar ? 'تفعيل إشعارات تيليجرام' : 'Enable Telegram notifications'}
              ar={ar}
            />
            <div style={{ ...help, marginBlockEnd: 14 }}>
              {ar
                ? 'يدفع تنبيهات المهام الحمراء (الحرجة) إلى تيليجرام. يتطلّب أيضاً تعبئة رمز البوت ومعرّف المحادثة أدناه، وأن تكون التنبيهات داخل التطبيق مُفعّلة.'
                : 'Pushes red (critical) task alerts to Telegram. Also requires the bot token and chat id below to be filled in, and in-app alerts to be enabled.'}
            </div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBlockEnd: 6, color: 'var(--text-primary, #232220)' }}>
              {ar ? 'رمز بوت تيليجرام' : 'Telegram bot token'}
            </label>
            <input
              type="text"
              dir="ltr"
              disabled={!canEdit}
              value={settings.telegram_bot_token}
              onChange={(e) => { setSaved(false); setSettings({ ...settings, telegram_bot_token: e.target.value }); }}
              style={inputStyle}
              placeholder="123456:ABC-DEF..."
            />
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 6px', color: 'var(--text-primary, #232220)' }}>
              {ar ? 'معرّف محادثة تيليجرام' : 'Telegram chat id'}
            </label>
            <input
              type="text"
              dir="ltr"
              disabled={!canEdit}
              value={settings.telegram_chat_id}
              onChange={(e) => { setSaved(false); setSettings({ ...settings, telegram_chat_id: e.target.value }); }}
              style={inputStyle}
              placeholder="-1001234567890"
            />
            <div style={help}>
              {ar
                ? 'يُستخدم لدفع تنبيهات الملفات الحمراء إلى تيليجرام عند تفعيل الخيار أعلاه.'
                : 'Used to push red-file alerts to Telegram when the toggle above is on.'}
            </div>
          </div>

          {canEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                style={{
                  padding: '11px 22px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--albaker-gold, #BD9446)',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 14.5,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'حفظ' : 'Save'}
              </button>
              {saved && (
                <span style={{ color: 'var(--ok-green, #4F8A63)', fontSize: 13.5, fontWeight: 600 }}>
                  {ar ? 'تم الحفظ ✓ — ستُحدّث ألوان الملفات.' : 'Saved ✓ — file colors will update.'}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {showManageTypes && (
        <ManageFolderTypesModal onClose={() => setShowManageTypes(false)} />
      )}
    </div>
  );
}

/** A labelled on/off switch (admin editable; disabled = read-only for managers). */
function ToggleRow({
  on,
  disabled,
  onChange,
  title,
  ar,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  title: string;
  ar: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary, #232220)',
        }}
      >
        {title}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        disabled={disabled}
        onClick={() => !disabled && onChange(!on)}
        style={{
          position: 'relative',
          width: 46,
          height: 26,
          flexShrink: 0,
          borderRadius: 999,
          border: 'none',
          padding: 0,
          cursor: disabled ? 'default' : 'pointer',
          background: on ? 'var(--albaker-gold, #BD9446)' : 'var(--border, #D8D5CD)',
          opacity: disabled ? 0.6 : 1,
          transition: 'background 0.15s ease',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 3,
            insetInlineStart: on ? 23 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            transition: 'inset-inline-start 0.15s ease',
          }}
        />
      </button>
      <span className="sr-only" style={{ display: 'none' }}>
        {on ? (ar ? 'مُفعّل' : 'On') : ar ? 'مُوقف' : 'Off'}
      </span>
    </div>
  );
}

function stepBtn(disabled: boolean): CSSProperties {
  return {
    width: 38,
    height: 38,
    borderRadius: 8,
    border: '1px solid var(--border, #E9E7E0)',
    background: 'var(--bg-cell, #F3F2ED)',
    color: 'var(--text-primary, #232220)',
    fontSize: 20,
    lineHeight: 1,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  borderRadius: 8,
  border: '1px solid var(--border, #E9E7E0)',
  background: 'var(--bg-cell, #F3F2ED)',
  color: 'var(--text-primary, #232220)',
  boxSizing: 'border-box',
};
