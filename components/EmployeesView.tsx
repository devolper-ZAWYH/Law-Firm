'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDash } from './DashboardShell';
import TimeOfDayPicker from './TimeOfDayPicker';
import {
  PAYLATER_ROLES,
  toPaylaterRole,
  type PaylaterRole,
} from '@/lib/platform/paylaterRoles';
import {
  CAPABILITY_TREE,
  isApprovableCapability,
  type CapabilityGroup,
  type CapabilityKey,
  type CapabilityNode,
} from '@/lib/platform/capabilities';

/**
 * Employees directory — Phase 8. Admin, manager, or an employee granted any
 * 'people.*' capability (the page/route gates re-enforce this). Active-
 * company scoped.
 *
 * Lists the active company's MEMBERS with a role tag (Admin / Manager /
 * Employee) and lets an admin add an employee by email. Added rows are DIRECTORY
 * entries — login credentials are set separately via User Accounts.
 *
 * Bilingual + RTL via useDash().lang (inline strings — no new i18n keys).
 */

interface Member {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string;
  role: 'manager' | 'employee';
  isAdmin: boolean;
  /** Frozen accounts cannot sign in; freezing also kicks out any live session. */
  isFrozen: boolean;
  /** Matches attendance-sheet rows to this person (see lib/platform/attendance.ts).
   * A code-level identifier only — dashboard users are still identified by name. */
  employeeId: string | null;
}

const AVATAR_COLORS = ['#BD9446', '#6E8B74', '#8A6E5A', '#5B6E8C', '#96707A', '#7A7A5B'];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function EmployeesView() {
  const { lang, activeCompany, identity } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';
  const isAdmin = activeCompany?.role === 'admin';
  const isManager = activeCompany?.role === 'manager';

  // The caller's OWN 'people.*' grants — relevant only when they are neither
  // admin nor manager (those two already pass every check below). Each of the
  // three editable field families on another member's row (schedule, ZKTeco
  // id, permissions) is gated on its OWN capability, mirroring the PATCH
  // route's per-field enforcement — a grant of one must not silently unlock
  // the others in the UI (the server would reject them anyway, turning what
  // looks like a saved change into a confusing 403).
  const [myCapabilities, setMyCapabilities] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!companyId || isAdmin || isManager) {
      setMyCapabilities(new Set());
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
          setMyCapabilities(new Set(data.capabilities));
        }
      } catch {
        /* keep the empty set — every field family below then stays locked */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, isAdmin, isManager]);

  const canEditSchedule = isAdmin || isManager || myCapabilities.has('people.schedule');
  const canEditZkteco = isAdmin || isManager || myCapabilities.has('people.zkteco');
  const canEditPermissions =
    isAdmin || isManager || myCapabilities.has('people.permissions');

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [deletingMember, setDeletingMember] = useState<Member | null>(null);
  const [pwMember, setPwMember] = useState<Member | null>(null);
  /** userId currently being frozen/unfrozen, so only that row's button spins. */
  const [freezing, setFreezing] = useState<string | null>(null);

  /**
   * Freeze or unfreeze an account. Freezing signs the person out everywhere
   * immediately (the server revokes their outstanding sessions), so confirm
   * first — it is not a quiet toggle.
   */
  async function toggleFrozen(m: Member) {
    const next = !m.isFrozen;
    if (next) {
      const warn = ar
        ? `تجميد ${displayName(m)}؟ لن يتمكن من تسجيل الدخول، وسيتم إخراجه فورًا إن كان مسجلاً الآن. لن يتم حذف أي بيانات.`
        : `Freeze ${displayName(m)}? They will not be able to sign in, and will be signed out immediately if currently active. No data is deleted.`;
      if (!window.confirm(warn)) return;
    }
    setFreezing(m.userId);
    try {
      const res = await fetch(
        `/api/companies/${companyId}/employees/${m.userId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isFrozen: next }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || (ar ? 'تعذّر تحديث الحساب.' : 'Could not update the account.'));
        return;
      }
      setMembers((prev) =>
        prev.map((x) => (x.userId === m.userId ? { ...x, isFrozen: next } : x))
      );
    } catch {
      setError(ar ? 'تعذّر تحديث الحساب.' : 'Could not update the account.');
    } finally {
      setFreezing(null);
    }
  }

  const load = useCallback(async () => {
    if (!companyId) {
      setMembers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/employees`, { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: Member[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.members)) {
        setError(ar ? 'تعذّر تحميل الموظفين.' : 'Could not load employees.');
        setMembers([]);
      } else {
        setMembers(data.members);
      }
    } catch {
      setError(ar ? 'تعذّر تحميل الموظفين.' : 'Could not load employees.');
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [companyId, ar]);

  useEffect(() => {
    load();
  }, [load]);

  function onAdded(member: Member) {
    setMembers((prev) => {
      const exists = prev.some((m) => m.userId === member.userId);
      return exists ? prev.map((m) => (m.userId === member.userId ? member : m)) : [...prev, member];
    });
    setAdding(false);
  }

  function onUpdated(member: Member) {
    setMembers((prev) => prev.map((m) => (m.userId === member.userId ? member : m)));
    setEditing(null);
  }

  function onDeleted(userId: string) {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    setDeletingMember(null);
  }

  function displayName(m: Member): string {
    const n = (ar ? m.nameAr : m.nameEn) || m.nameEn || m.nameAr;
    return n && n.trim() ? n : m.email;
  }
  function initialOf(m: Member): string {
    const n = displayName(m).trim();
    return n ? n[0].toUpperCase() : '?';
  }
  function roleTag(m: Member): { label: string; color: string } {
    if (m.isAdmin) return { label: ar ? 'مشرف' : 'Admin', color: '#BD9446' };
    if (m.role === 'manager') return { label: ar ? 'مدير' : 'Manager', color: '#5B6E8C' };
    return { label: ar ? 'موظف' : 'Employee', color: '#6E8B74' };
  }

  if (!activeCompany) {
    return (
      <>
        <h1 className="dash-title">{ar ? 'الموظفون' : 'Employees'}</h1>
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {ar ? 'اختر شركة أولاً.' : 'Select a company first.'}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{ar ? 'الموظفون' : 'Employees'}</h1>
          <p className="dash-subtitle">{ar ? activeCompany.nameAr : activeCompany.nameEn}</p>
        </div>
        {isAdmin && (
          <button type="button" className="dash-btn-gold" onClick={() => setAdding(true)}>
            + {ar ? 'إضافة موظف' : 'Add employee'}
          </button>
        )}
      </div>

      <p className="dash-subtitle" style={{ marginBlockEnd: 16 }}>
        {ar
          ? 'دليل أعضاء هذه الشركة. تُضبط بيانات تسجيل الدخول بشكل منفصل من «حسابات المستخدمين».'
          : 'A directory of this company’s members. Login credentials are set separately from User Accounts.'}
      </p>

      {error && (
        <div className="dash-alert dash-alert-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="dash-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {ar ? 'جارٍ التحميل…' : 'Loading…'}
          </p>
        </div>
      ) : members.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {ar ? 'لا يوجد أعضاء بعد.' : 'No members yet.'}
          </p>
        </div>
      ) : (
        <div className="dash-card" style={{ padding: 0 }}>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>{ar ? 'الاسم' : 'Name'}</th>
                  <th>{ar ? 'الدور' : 'Role'}</th>
                  <th>{ar ? 'رقم الموظف' : 'Employee ID'}</th>
                  <th>{ar ? 'البريد الإلكتروني' : 'Email'}</th>
                  <th style={{ width: 1 }} aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const tag = roleTag(m);
                  return (
                    <tr key={m.userId} style={m.isFrozen ? { opacity: 0.55 } : undefined}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <span style={avatarStyle(avatarColor(displayName(m)))} aria-hidden="true">
                            {initialOf(m)}
                          </span>
                          <span style={{ fontWeight: 600 }}>{displayName(m)}</span>
                          {m.isFrozen && (
                            <span
                              style={roleTagStyle('#9a3b2f')}
                              title={ar ? 'لا يمكنه تسجيل الدخول' : 'Cannot sign in'}
                            >
                              {ar ? 'مجمّد' : 'Frozen'}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span style={roleTagStyle(tag.color)}>{tag.label}</span>
                      </td>
                      <td className="dash-td-muted" dir="ltr" style={{ textAlign: ar ? 'right' : 'left' }}>
                        {m.employeeId || '—'}
                      </td>
                      <td className="dash-td-muted" dir="ltr" style={{ textAlign: ar ? 'right' : 'left' }}>
                        {m.email}
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className="dash-btn-ghost"
                            style={smallBtn}
                            onClick={() => setEditing(m)}
                          >
                            {ar ? 'تعديل' : 'Edit'}
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              className="dash-btn-ghost"
                              style={smallBtn}
                              onClick={() => setPwMember(m)}
                            >
                              {ar ? 'تعيين كلمة مرور' : 'Set password'}
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              className="dash-btn-ghost"
                              style={{
                                ...smallBtn,
                                color: m.isFrozen ? '#2f6b3a' : '#9a3b2f',
                              }}
                              disabled={freezing === m.userId}
                              onClick={() => toggleFrozen(m)}
                              title={
                                m.isFrozen
                                  ? ar
                                    ? 'إعادة تفعيل الحساب'
                                    : 'Restore access'
                                  : ar
                                  ? 'منع تسجيل الدخول وإخراجه فورًا'
                                  : 'Block sign-in and sign them out now'
                              }
                            >
                              {freezing === m.userId
                                ? '…'
                                : m.isFrozen
                                ? ar
                                  ? 'إلغاء التجميد'
                                  : 'Unfreeze'
                                : ar
                                ? 'تجميد'
                                : 'Freeze'}
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              className="dash-btn-ghost"
                              style={{ ...smallBtn, color: '#9a3b2f' }}
                              onClick={() => setDeletingMember(m)}
                            >
                              {ar ? 'حذف' : 'Delete'}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && companyId && (
        <AddEmployeeModal
          companyId={companyId}
          ar={ar}
          onClose={() => setAdding(false)}
          onAdded={onAdded}
        />
      )}

      {editing && companyId && (
        <EditEmployeeModal
          companyId={companyId}
          member={editing}
          ar={ar}
          isAdmin={isAdmin}
          canEditSchedule={canEditSchedule}
          canEditZkteco={canEditZkteco}
          canEditPermissions={canEditPermissions}
          isSelf={editing.userId === identity.userId}
          onClose={() => setEditing(null)}
          onUpdated={onUpdated}
        />
      )}

      {deletingMember && companyId && (
        <DeleteEmployeeModal
          companyId={companyId}
          member={deletingMember}
          ar={ar}
          displayName={displayName(deletingMember)}
          onClose={() => setDeletingMember(null)}
          onDeleted={onDeleted}
        />
      )}

      {pwMember && companyId && (
        <SetPasswordModal
          companyId={companyId}
          member={pwMember}
          ar={ar}
          displayName={displayName(pwMember)}
          onClose={() => setPwMember(null)}
        />
      )}
    </>
  );
}

function AddEmployeeModal({
  companyId,
  ar,
  onClose,
  onAdded,
}: {
  companyId: string;
  ar: boolean;
  onClose: () => void;
  onAdded: (m: Member) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError(ar ? 'البريد الإلكتروني مطلوب.' : 'Email is required.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/employees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        member?: Member;
      };
      if (!res.ok || !data.ok || !data.member) {
        setError(data.error || (ar ? 'تعذّر الإضافة.' : 'Could not add.'));
        setSaving(false);
        return;
      }
      onAdded(data.member);
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setSaving(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'إضافة موظف' : 'Add employee'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {ar ? 'إضافة موظف' : 'Add employee'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="emp-email">
              {ar ? 'البريد الإلكتروني' : 'Email'}
            </label>
            <input
              id="emp-email"
              className="dash-input"
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              required
            />
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="emp-name">
              {ar ? 'الاسم' : 'Name'}{' '}
              <span className="dash-hint" style={{ display: 'inline' }}>
                {ar ? '(اختياري)' : '(optional)'}
              </span>
            </label>
            <input
              id="emp-name"
              className="dash-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <p className="dash-subtitle" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
            {ar
              ? 'يُضاف عضواً في هذه الشركة (دور: موظف). إن لم يكن لديه حساب، يُنشأ سجل دليل لا يمكنه تسجيل الدخول حتى تُضبط كلمة المرور من «حسابات المستخدمين».'
              : 'Adds them as a member of this company (role: employee). If they have no account, a directory entry is created that cannot log in until a password is set from User Accounts.'}
          </p>

          <div className="dash-modal-actions">
            <button type="button" className="dash-btn-ghost" onClick={onClose} disabled={saving}>
              {ar ? 'إلغاء' : 'Cancel'}
            </button>
            <button type="submit" className="dash-btn-gold" disabled={saving}>
              {saving ? (ar ? 'جارٍ الإضافة…' : 'Adding…') : ar ? 'إضافة' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Every key in a node's own subtree (itself + all descendants), for
 * "check the parent → check everything under it" toggling. */
function subtreeKeys(node: CapabilityNode): CapabilityKey[] {
  const out = [node.key];
  if (node.children) for (const c of node.children) out.push(...subtreeKeys(c));
  return out;
}

/**
 * One row of the capability tree: a checkbox that checks/unchecks its whole
 * subtree at once, indeterminate when only some descendants are granted, plus
 * its own children rendered indented underneath.
 */
function CapabilityRow({
  node,
  depth,
  grants,
  onToggle,
  approvalRequired,
  onToggleApproval,
  ar,
  disabled,
}: {
  node: CapabilityNode;
  depth: number;
  grants: Set<CapabilityKey>;
  onToggle: (keys: CapabilityKey[], checked: boolean) => void;
  approvalRequired: Set<CapabilityKey>;
  onToggleApproval: (key: CapabilityKey, checked: boolean) => void;
  ar: boolean;
  disabled: boolean;
}) {
  const keys = subtreeKeys(node);
  const checkedCount = keys.filter((k) => grants.has(k)).length;
  const allChecked = checkedCount === keys.length;
  const someChecked = checkedCount > 0 && !allChecked;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someChecked;
  }, [someChecked]);

  // THE QUESTION THE MANAGER IS ASKED. It appears only once the permission is
  // actually granted — asking "does this need approval?" about something the
  // person cannot do would be noise — and only for capabilities the server can
  // genuinely hold (isApprovableCapability), so this can never be a switch
  // that silently does nothing.
  const held = grants.has(node.key) || someChecked;
  const showApproval = !disabled && held && isApprovableCapability(node.key);

  return (
    <div style={{ marginInlineStart: depth * 18, marginBottom: depth === 0 ? 8 : 4 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
        <input
          ref={ref}
          type="checkbox"
          checked={allChecked}
          disabled={disabled}
          onChange={() => onToggle(keys, !allChecked)}
        />
        {ar ? node.ar : node.en}
      </label>
      {(node.hintEn || node.hintAr) && (
        <div className="dash-hint" style={{ marginInlineStart: 22, marginTop: 1 }}>
          {ar ? node.hintAr : node.hintEn}
        </div>
      )}
      {showApproval && (
        <label
          className="dash-hint"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginInlineStart: 22,
            marginTop: 3,
          }}
        >
          <input
            type="checkbox"
            checked={approvalRequired.has(node.key)}
            onChange={(e) => onToggleApproval(node.key, e.target.checked)}
          />
          {ar
            ? 'يتطلب موافقة — لا يُنفَّذ الإجراء قبل موافقة المدير المعتمد'
            : 'Requires approval — nothing happens until the approving manager says yes'}
        </label>
      )}
      {node.children?.map((c) => (
        <CapabilityRow
          key={c.key}
          node={c}
          depth={depth + 1}
          grants={grants}
          onToggle={onToggle}
          approvalRequired={approvalRequired}
          onToggleApproval={onToggleApproval}
          ar={ar}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

/** Every key under a group, for the "N granted" count on a collapsed header. */
function groupKeys(group: CapabilityGroup): CapabilityKey[] {
  const out: CapabilityKey[] = [];
  for (const node of group.capabilities) out.push(...subtreeKeys(node));
  return out;
}

/**
 * The full capability tree (lib/platform/capabilities.ts) as a grantable
 * checkbox list — everything a manager can do that a plain employee cannot,
 * grouped by area (Folders, Tasks, Attendance, People, Company, Notifications).
 *
 * EVERY SECTION STARTS COLLAPSED. Expanded, the six groups run to well over a
 * screen of checkboxes, and the tab opened on a wall of them with no way to
 * see its shape. Collapsed, the whole permission model is six lines.
 *
 * A collapsed section still says what is inside it: the header carries a count
 * of granted keys, so closing a section never hides the fact that something is
 * granted in it. Without that, "collapsed by default" would mean opening all
 * six every time just to find out what a person already has.
 */
function CapabilityTreeEditor({
  grants,
  onChange,
  approvalRequired,
  onApprovalChange,
  ar,
  disabled,
}: {
  grants: CapabilityKey[];
  onChange: (next: CapabilityKey[]) => void;
  approvalRequired: CapabilityKey[];
  onApprovalChange: (next: CapabilityKey[]) => void;
  ar: boolean;
  disabled: boolean;
}) {
  const grantSet = new Set(grants);
  const approvalSet = new Set(approvalRequired);
  // Which sections are open. Empty = all closed, which is the opening state.
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  function toggleSection(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggle(keys: CapabilityKey[], checked: boolean) {
    const next = new Set(grantSet);
    for (const k of keys) {
      if (checked) next.add(k);
      else next.delete(k);
    }
    onChange(Array.from(next));
    // Un-granting a permission must take its gate with it, or an inert flag
    // would be left behind to reappear if the permission is granted again
    // later — silently, and not necessarily by the person who set it.
    if (!checked) {
      const stillGated = approvalRequired.filter((k) => !keys.includes(k));
      if (stillGated.length !== approvalRequired.length) onApprovalChange(stillGated);
    }
  }
  function toggleApproval(key: CapabilityKey, checked: boolean) {
    const next = new Set(approvalSet);
    if (checked) next.add(key);
    else next.delete(key);
    onApprovalChange(Array.from(next));
  }
  return (
    <div style={{ opacity: disabled ? 0.5 : 1 }}>
      {CAPABILITY_TREE.map((group) => {
        const isOpen = open.has(group.key);
        const bodyId = `cap-section-${group.key}`;
        const grantedCount = groupKeys(group).filter((k) => grantSet.has(k)).length;
        return (
          <div key={group.key} className="cap-section">
            <button
              type="button"
              className="cap-section-head"
              onClick={() => toggleSection(group.key)}
              aria-expanded={isOpen}
              aria-controls={bodyId}
            >
              {/* Chevron: points into the page when closed, down when open.
                  The RTL mirroring and the open rotation are both in CSS
                  (.cap-section-chevron), so this carries only the state. */}
              <span
                aria-hidden="true"
                className={
                  isOpen ? 'cap-section-chevron is-open' : 'cap-section-chevron'
                }
              >
                ›
              </span>
              <span className="cap-section-title">{ar ? group.ar : group.en}</span>
              {grantedCount > 0 && (
                // A number beside Arabic text reorders unless it is marked —
                // see the LTR note in CLAUDE.md.
                <span className="cap-section-count" dir="ltr">
                  {grantedCount}
                </span>
              )}
            </button>
            {isOpen && (
              <div id={bodyId} className="cap-section-body">
                {(group.hintEn || group.hintAr) && (
                  <div className="dash-hint" style={{ marginBottom: 6 }}>
                    {ar ? group.hintAr : group.hintEn}
                  </div>
                )}
                {group.capabilities.map((node) => (
                  <CapabilityRow
                    key={node.key}
                    node={node}
                    depth={0}
                    grants={grantSet}
                    onToggle={toggle}
                    approvalRequired={approvalSet}
                    onToggleApproval={toggleApproval}
                    ar={ar}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface WorkingHoursFields {
  workingDays: number[] | null;
  startTime: string | null;
  endTime: string | null;
}
const NO_HOURS: WorkingHoursFields = { workingDays: null, startTime: null, endTime: null };
const WEEKDAYS: Array<{ n: number; en: string; ar: string }> = [
  { n: 0, en: 'Sun', ar: 'أحد' },
  { n: 1, en: 'Mon', ar: 'اثنين' },
  { n: 2, en: 'Tue', ar: 'ثلاثاء' },
  { n: 3, en: 'Wed', ar: 'أربعاء' },
  { n: 4, en: 'Thu', ar: 'خميس' },
  { n: 5, en: 'Fri', ar: 'جمعة' },
  { n: 6, en: 'Sat', ar: 'سبت' },
];

function EditEmployeeModal({
  companyId,
  member,
  ar,
  isAdmin,
  canEditSchedule,
  canEditZkteco,
  canEditPermissions,
  isSelf,
  onClose,
  onUpdated,
}: {
  companyId: string;
  member: Member;
  ar: boolean;
  /** Admin sees/edits name+email+role too; a manager (or capability-granted
   * employee) sees ONLY the field families they were specifically granted. */
  isAdmin: boolean;
  /** True for admin/manager, or an employee granted 'people.schedule'. */
  canEditSchedule: boolean;
  /** True for admin/manager, or an employee granted 'people.zkteco'. */
  canEditZkteco: boolean;
  /** True for admin/manager, or an employee granted 'people.permissions'. */
  canEditPermissions: boolean;
  /** True when this row is the signed-in user's own membership. */
  isSelf: boolean;
  onClose: () => void;
  onUpdated: (m: Member) => void;
}) {
  const [nameEn, setNameEn] = useState(member.nameEn ?? '');
  const [nameAr, setNameAr] = useState(member.nameAr ?? '');
  const [email, setEmail] = useState(member.email ?? '');
  const [role, setRole] = useState<'manager' | 'employee'>(member.role);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Mirrors the server-side privilege-escalation guard: a non-admin may not
  // grant permissions to themselves. Everything else on their own row (working
  // hours, ZKTeco id) stays editable. Also locked outright when the caller
  // simply was never granted 'people.permissions' in the first place.
  const lockPermissions = (isSelf && !isAdmin) || !canEditPermissions;

  const [capabilityGrants, setCapabilityGrants] = useState<CapabilityKey[]>([]);
  const [approvalRequired, setApprovalRequired] = useState<CapabilityKey[]>([]);
  const [hours, setHours] = useState<WorkingHoursFields>(NO_HOURS);
  const [zktecoId, setZktecoId] = useState('');
  // ONE role or none — a select, not a set of checkboxes. See paylaterRoles.ts.
  const [paylaterRole, setPaylaterRole] = useState<PaylaterRole | ''>('');
  /** Omit this person from the Employee Tasks workload calendar (#41). */
  const [hiddenFromWorkload, setHiddenFromWorkload] = useState(false);
  /*
    THE WEEK AS INTERVALS (#42) — office or online, several a day.

    The From/To pair above says "in the office, 09:00 to 17:00" and cannot say
    anything else. A real schedule handed to us reads: Sunday online 09:00–12:00
    then office 14:30–16:30; Wednesday online all day; Thursday three hours.
    With one start time that Sunday has to begin at 09:00, so somebody working
    online at nine and reaching the office at half past two is logged five and a
    half hours late, every week.

    Entered as one TERM — a start date, an optional end date, and the blocks —
    because a schedule belongs to a term and editing this one must not re-judge
    the last.
  */
  const [termFrom, setTermFrom] = useState('');
  const [termTo, setTermTo] = useState('');
  const [blocks, setBlocks] = useState<
    Array<{ weekday: number; startTime: string; endTime: string; mode: 'office' | 'online' }>
  >([]);
  const [blocksLoaded, setBlocksLoaded] = useState(false);
  const [loadingExtra, setLoadingExtra] = useState(true);
  const [tab, setTab] = useState<'details' | 'permissions'>('details');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExtra(true);
      try {
        const res = await fetch(
          `/api/companies/${companyId}/employees/${member.userId}`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          capabilityGrants?: CapabilityKey[];
          approvalRequired?: CapabilityKey[];
          workingHours?: WorkingHoursFields;
          zktecoId?: string | null;
          paylaterRole?: string | null;
          hiddenFromWorkload?: boolean;
          scheduleBlocks?: Array<{
            weekday: number;
            startTime: string;
            endTime: string;
            mode: 'office' | 'online';
            validFrom: string;
            validTo: string | null;
          }>;
        };
        if (!cancelled && res.ok && data.ok) {
          if (data.capabilityGrants) setCapabilityGrants(data.capabilityGrants);
          if (data.approvalRequired) setApprovalRequired(data.approvalRequired);
          if (data.workingHours) setHours(data.workingHours);
          setZktecoId(data.zktecoId ?? '');
          setPaylaterRole(toPaylaterRole(data.paylaterRole) ?? '');
          setHiddenFromWorkload(data.hiddenFromWorkload === true);
          // Newest term first (the route orders them), so the first row names
          // the term being edited and the rest of that term comes with it.
          const stored = data.scheduleBlocks ?? [];
          const newest = stored[0];
          if (newest) {
            setTermFrom(newest.validFrom);
            setTermTo(newest.validTo ?? '');
            setBlocks(
              stored
                .filter((b) => b.validFrom === newest.validFrom)
                .map((b) => ({
                  weekday: b.weekday,
                  startTime: b.startTime,
                  endTime: b.endTime,
                  mode: b.mode,
                }))
            );
          }
          setBlocksLoaded(true);
        }
      } finally {
        if (!cancelled) setLoadingExtra(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, member.userId]);

  function toggleDay(n: number) {
    setHours((h) => {
      const cur = h.workingDays ?? [];
      const next = cur.includes(n) ? cur.filter((d) => d !== n) : [...cur, n].sort();
      return { ...h, workingDays: next };
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      // Each field family is gated on its own grant (see the PATCH route's
      // per-field checks) — sending a field the caller lacks would 403 the
      // WHOLE request, so omit rather than include-and-fail. A non-admin also
      // may not change their OWN permissions (the privilege-escalation guard;
      // folded into lockPermissions above).
      if (canEditSchedule) body.workingHours = hours;
      if (canEditZkteco) body.zktecoId = zktecoId.trim() || null;
      // Who appears on the workload calendar is a SCHEDULING decision, so it
      // travels with the schedule permission rather than with the grants: the
      // person who sets someone's working days is the person deciding whether
      // they are planned for at all.
      if (canEditSchedule) body.hiddenFromWorkload = hiddenFromWorkload;
      // Sent only once the existing schedule has been read, so opening and
      // saving the card before it loads cannot wipe somebody's week. A term
      // with no start date is not a term, and an empty block list with one is
      // a deliberate "clear this term".
      if (canEditSchedule && blocksLoaded && termFrom) {
        body.scheduleTerm = {
          validFrom: termFrom,
          validTo: termTo || null,
          blocks,
        };
      }
      if (!lockPermissions) {
        // Gated on 'people.permissions', same as the grants below it: staffing
        // the PayLater team is a permission decision, not an identity edit.
        body.paylaterRole = paylaterRole === '' ? null : paylaterRole;
        body.capabilityGrants = capabilityGrants;
        // Only meaningful together with the grant list — the flag lives on the
        // grant row, and the route ignores it when sent alone.
        body.approvalRequired = approvalRequired;
      }
      if (isAdmin) {
        body.nameEn = nameEn;
        body.nameAr = nameAr;
        body.email = email;
        body.role = role;
      }
      const res = await fetch(`/api/companies/${companyId}/employees/${member.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        member?: Omit<Member, 'employeeId'>;
        zktecoId?: string | null;
      };
      if (!res.ok || !data.ok || !data.member) {
        setError(data.error || (ar ? 'تعذّر الحفظ.' : 'Could not save.'));
        setSaving(false);
        return;
      }
      onUpdated({ ...data.member, employeeId: data.zktecoId ?? null });
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setSaving(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'تعديل الموظف' : 'Edit employee'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {ar ? 'تعديل الموظف' : 'Edit employee'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <div className="dash-tabs" style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
          <button
            type="button"
            className={tab === 'details' ? 'dash-btn-gold' : 'dash-btn-ghost'}
            style={{ padding: '5px 12px', fontSize: 13 }}
            onClick={() => setTab('details')}
          >
            {ar ? 'التفاصيل' : 'Details'}
          </button>
          <button
            type="button"
            className={tab === 'permissions' ? 'dash-btn-gold' : 'dash-btn-ghost'}
            style={{ padding: '5px 12px', fontSize: 13 }}
            onClick={() => setTab('permissions')}
          >
            {ar ? 'الصلاحيات' : 'Permissions'}
          </button>
        </div>

        <form onSubmit={onSubmit} noValidate>
          <div style={{ display: tab === 'details' ? undefined : 'none' }}>
          {isAdmin && (
            <>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-edit-name-en">
                  {ar ? 'الاسم (إنجليزي)' : 'Name (English)'}
                </label>
                <input
                  id="emp-edit-name-en"
                  className="dash-input"
                  dir="ltr"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-edit-name-ar">
                  {ar ? 'الاسم (عربي)' : 'Name (Arabic)'}
                </label>
                <input
                  id="emp-edit-name-ar"
                  className="dash-input"
                  dir="rtl"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-edit-email">
                  {ar ? 'البريد الإلكتروني' : 'Email'}
                </label>
                <input
                  id="emp-edit-email"
                  className="dash-input"
                  dir="ltr"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-edit-role">
                  {ar ? 'الدور' : 'Role'}
                </label>
                <select
                  id="emp-edit-role"
                  className="dash-input"
                  value={role}
                  onChange={(e) => setRole(e.target.value === 'manager' ? 'manager' : 'employee')}
                >
                  <option value="manager">{ar ? 'مدير' : 'Manager'}</option>
                  <option value="employee">{ar ? 'موظف' : 'Employee'}</option>
                </select>
              </div>
              <p className="dash-subtitle" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
                {ar
                  ? 'يُحدِّث الاسم والبريد والدور. غيّر كلمة المرور من زر «تعيين كلمة مرور».'
                  : 'Updates name, email and role. Change the password from the “Set password” button.'}
              </p>
            </>
          )}

          {/*
            THE PAYLATER ROLE — a dropdown, sitting with the platform role it
            resembles rather than down among the permission checkboxes.

            It is a SELECT because the four roles are mutually exclusive jobs:
            the Lawyer signs the notice and the Auditor checks it, so one person
            holding both turns a review into a self-review. This shipped briefly
            as four checkboxes, which said the opposite — that they stack. The
            value is now a single column (memberships.paylater_role), so "two
            roles" is not something the UI has to prevent; it cannot be stored.

            Gated on 'people.permissions' like the other grants, and disabled
            (not hidden) when the caller lacks it, so they can still SEE what
            this person's role is without being able to change it.
          */}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="emp-paylater-role">
              {ar ? 'دور باي لاتر' : 'PayLater role'}
            </label>
            <select
              id="emp-paylater-role"
              className="dash-input"
              value={paylaterRole}
              disabled={loadingExtra || lockPermissions}
              onChange={(e) =>
                setPaylaterRole(toPaylaterRole(e.target.value) ?? '')
              }
            >
              <option value="">{ar ? 'لا يوجد' : 'None'}</option>
              {PAYLATER_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {ar ? r.ar : r.en}
                </option>
              ))}
            </select>
            <p className="dash-subtitle" style={{ margin: '4px 0 12px', fontSize: 12.5 }}>
              {paylaterRole
                ? ar
                  ? PAYLATER_ROLES.find((r) => r.value === paylaterRole)?.hintAr
                  : PAYLATER_ROLES.find((r) => r.value === paylaterRole)?.hintEn
                : ar
                  ? 'دور واحد لكل شخص. المديرون والمشرفون يدخلون البوابة بحكم دورهم دون تعيين.'
                  : 'One role per person. Admins and managers reach the portal by role, without one.'}
            </p>
          </div>

          {/*
            WHETHER THIS PERSON IS PLANNED FOR.

            The workload calendar lists the whole roster on purpose — an empty
            load bar is the most useful row on the screen when a manager is
            asking who is free. But a roster carrying people nobody will ever
            assign work to makes the useful rows harder to find, so one person
            can be taken out of that view from here.

            NOT A PERMISSION. It hides a row on one screen: this person keeps
            every grant they had, can still be assigned a task, and their
            existing tasks still count. Frozen accounts drop off that calendar
            on their own and do not need this ticked.
          */}
          <div className="dash-field">
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}
            >
              <input
                type="checkbox"
                checked={hiddenFromWorkload}
                disabled={loadingExtra || !canEditSchedule}
                onChange={(e) => setHiddenFromWorkload(e.target.checked)}
              />
              {ar
                ? 'إخفاء من تقويم مهام الموظفين'
                : 'Hide from the Employee Tasks calendar'}
            </label>
            <p className="dash-subtitle" style={{ margin: '4px 0 12px', fontSize: 12.5 }}>
              {ar
                ? 'يخفي صف هذا الشخص من التقويم فقط. لا يغيّر صلاحياته ولا يمنع إسناد المهام إليه.'
                : 'Removes this person’s row from that calendar only. It changes no permission and does not stop tasks being assigned to them.'}
            </p>
          </div>

          {/* Employee ID — used to match uploaded attendance-sheet rows (and,
              going forward, other ID-based lookups) to this person, not by
              name, to avoid spelling mismatches. A code-level identifier only —
              dashboard users still work with this person by name everywhere else. */}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="emp-zkteco-id">
              {ar ? 'رقم الموظف' : 'Employee ID'}
            </label>
            <input
              id="emp-zkteco-id"
              className="dash-input"
              dir="ltr"
              value={zktecoId}
              disabled={loadingExtra || !canEditZkteco}
              onChange={(e) => setZktecoId(e.target.value)}
              placeholder={ar ? 'مثال: 104' : 'e.g. 104'}
            />
          </div>

          {/* Working hours — the working DAYS drive which calendar days count
              toward this person's attendance late/early totals (see
              lib/platform/attendance.ts); start/end time are informational. */}
          <div className="dash-field">
            <label className="dash-eyebrow">
              {ar ? 'ساعات العمل' : 'Working hours'}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {WEEKDAYS.map((d) => {
                const active = (hours.workingDays ?? []).includes(d.n);
                return (
                  <button
                    key={d.n}
                    type="button"
                    className={active ? 'dash-btn-gold' : 'dash-btn-ghost'}
                    style={{ padding: '4px 10px', fontSize: 12.5 }}
                    disabled={loadingExtra || !canEditSchedule}
                    onClick={() => toggleDay(d.n)}
                  >
                    {ar ? d.ar : d.en}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <div className="dash-hint" style={{ marginBottom: 4 }}>
                  {ar ? 'من' : 'From'}
                </div>
                <TimeOfDayPicker
                  value={hours.startTime}
                  onChange={(v) => setHours((h) => ({ ...h, startTime: v }))}
                  ar={ar}
                  disabled={loadingExtra || !canEditSchedule}
                />
              </div>
              <div>
                <div className="dash-hint" style={{ marginBottom: 4 }}>
                  {ar ? 'إلى' : 'To'}
                </div>
                <TimeOfDayPicker
                  value={hours.endTime}
                  onChange={(v) => setHours((h) => ({ ...h, endTime: v }))}
                  ar={ar}
                  disabled={loadingExtra || !canEditSchedule}
                />
              </div>
            </div>
          </div>

          {/*
            THE WEEK AS INTERVALS — office or online.

            Sits under the From/To pair rather than replacing it: the pair still
            governs everybody who has no blocks, which is the whole team until
            somebody is given a schedule here. Adding a row is what switches
            this person over.
          */}
          <div className="dash-field">
            <div className="dash-eyebrow" style={{ marginBottom: 6 }}>
              {ar ? 'جدول الأسبوع (مكتب / أونلاين)' : 'Weekly schedule (office / online)'}
            </div>
            <p className="dash-subtitle" style={{ margin: '0 0 10px', fontSize: 12.5 }}>
              {ar
                ? 'فترات لكل يوم. الوقت غير المُغطّى إجازة. التأخير يُحتسب من أول فترة مكتب في اليوم — والأيام الأونلاين لا تُحتسب غيابًا لأن جهاز البصمة لا يراها.'
                : 'Intervals per day; time no interval covers is off. Lateness is measured from the day’s first OFFICE interval, and an online day is never counted absent — the attendance device cannot see it.'}
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
              <div>
                <div className="dash-hint" style={{ marginBottom: 4 }}>
                  {ar ? 'يبدأ في' : 'Term starts'}
                </div>
                <input
                  type="date"
                  className="dash-input"
                  value={termFrom}
                  disabled={loadingExtra || !canEditSchedule}
                  onChange={(e) => setTermFrom(e.target.value)}
                />
              </div>
              <div>
                <div className="dash-hint" style={{ marginBottom: 4 }}>
                  {ar ? 'ينتهي في (اختياري)' : 'Term ends (optional)'}
                </div>
                <input
                  type="date"
                  className="dash-input"
                  value={termTo}
                  disabled={loadingExtra || !canEditSchedule}
                  onChange={(e) => setTermTo(e.target.value)}
                />
              </div>
            </div>

            {blocks.length === 0 && (
              <p className="dash-hint" style={{ margin: '0 0 8px' }}>
                {ar
                  ? 'لا توجد فترات — تُستخدم ساعات العمل أعلاه.'
                  : 'No intervals — the working hours above are used instead.'}
              </p>
            )}

            {blocks.map((b, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <select
                  className="dash-input"
                  style={{ inlineSize: 'auto' }}
                  value={b.weekday}
                  disabled={!canEditSchedule}
                  aria-label={ar ? 'اليوم' : 'Day'}
                  onChange={(e) =>
                    setBlocks((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, weekday: Number(e.target.value) } : x
                      )
                    )
                  }
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.n} value={d.n}>
                      {ar ? d.ar : d.en}
                    </option>
                  ))}
                </select>
                {/*
                  TimeOfDayPicker, not <input type="time">, for the same two
                  reasons the From/To pair above uses it — and a third found
                  here the hard way.

                  A native time input renders in whatever format the OS locale
                  picks, usually 24h, when these are hours of a working day that
                  people say as "9 AM" and "2:30 PM". And inside an RTL page it
                  lays its own segments right-to-left: 09:00 was displayed as
                  "00:09" and 14:30 as "30:14", so the schedule read as
                  nonsense while the stored value was perfectly correct.

                  The picker is built from selects, which do not reorder, and it
                  speaks 'HH:MM' 24h on both sides — only its face is 12-hour.
                */}
                <TimeOfDayPicker
                  value={b.startTime}
                  ar={ar}
                  disabled={!canEditSchedule}
                  onChange={(v) =>
                    setBlocks((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, startTime: v ?? x.startTime } : x))
                    )
                  }
                />
                <TimeOfDayPicker
                  value={b.endTime}
                  ar={ar}
                  disabled={!canEditSchedule}
                  onChange={(v) =>
                    setBlocks((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, endTime: v ?? x.endTime } : x))
                    )
                  }
                />
                <select
                  className="dash-input"
                  style={{ inlineSize: 'auto' }}
                  value={b.mode}
                  disabled={!canEditSchedule}
                  aria-label={ar ? 'النمط' : 'Mode'}
                  onChange={(e) =>
                    setBlocks((prev) =>
                      prev.map((x, j) =>
                        j === i
                          ? { ...x, mode: e.target.value === 'online' ? 'online' : 'office' }
                          : x
                      )
                    )
                  }
                >
                  <option value="office">{ar ? 'مكتب' : 'Office'}</option>
                  <option value="online">{ar ? 'أونلاين' : 'Online'}</option>
                </select>
                {canEditSchedule && (
                  <button
                    type="button"
                    className="dash-btn-ghost"
                    style={{ padding: '6px 10px' }}
                    onClick={() => setBlocks((prev) => prev.filter((_, j) => j !== i))}
                  >
                    {ar ? 'حذف' : 'Remove'}
                  </button>
                )}
              </div>
            ))}

            {canEditSchedule && (
              <button
                type="button"
                className="dash-btn-ghost"
                style={{ marginTop: 4 }}
                onClick={() =>
                  setBlocks((prev) => [
                    ...prev,
                    { weekday: 0, startTime: '09:00', endTime: '12:00', mode: 'office' },
                  ])
                }
              >
                + {ar ? 'إضافة فترة' : 'Add interval'}
              </button>
            )}
          </div>
          </div>

          {/* Permissions tab — the full capability tree (lib/platform/capabilities.ts),
              grantable by an admin or a manager. Each responsibility is an
              independent grant on top of this person's baseline role access. */}
          <div style={{ display: tab === 'permissions' ? undefined : 'none' }}>
            {isSelf && !isAdmin && (
              <div className="dash-hint" style={{ marginBottom: 10 }}>
                {ar
                  ? 'لا يمكنك تغيير صلاحياتك الخاصة — يتولى ذلك المدير العام.'
                  : 'You cannot change your own permissions — an admin manages these.'}
              </div>
            )}
            {!canEditPermissions && !(isSelf && !isAdmin) && (
              <div className="dash-hint" style={{ marginBottom: 10 }}>
                {ar
                  ? 'لم تُمنح صلاحية «منح الصلاحيات» — لا يمكنك عرض أو تغيير هذا التبويب.'
                  : 'You were not granted "Grant these permissions to others" — you cannot view or change this tab.'}
              </div>
            )}
            <CapabilityTreeEditor
              grants={capabilityGrants}
              onChange={setCapabilityGrants}
              approvalRequired={approvalRequired}
              onApprovalChange={setApprovalRequired}
              ar={ar}
              disabled={loadingExtra || lockPermissions}
            />
          </div>

          <div className="dash-modal-actions">
            <button type="button" className="dash-btn-ghost" onClick={onClose} disabled={saving}>
              {ar ? 'إلغاء' : 'Cancel'}
            </button>
            <button type="submit" className="dash-btn-gold" disabled={saving}>
              {saving ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'حفظ' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteEmployeeModal({
  companyId,
  member,
  ar,
  displayName,
  onClose,
  onDeleted,
}: {
  companyId: string;
  member: Member;
  ar: boolean;
  displayName: string;
  onClose: () => void;
  onDeleted: (userId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function onConfirm() {
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/employees/${member.userId}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || (ar ? 'تعذّر الحذف.' : 'Could not remove.'));
        setDeleting(false);
        return;
      }
      onDeleted(member.userId);
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setDeleting(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'إزالة من الشركة' : 'Remove from company'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {ar ? 'إزالة من الشركة' : 'Remove from company'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <p className="dash-subtitle" style={{ margin: '4px 0 16px' }}>
          {ar
            ? `إزالة «${displayName}» من هذه الشركة؟ يُحذف عضويته وصلاحيات ملفاته في هذه الشركة فقط — لا يُحذف حسابه.`
            : `Remove “${displayName}” from this company? Their membership and file access in this company are removed — their account is not deleted.`}
        </p>

        <div className="dash-modal-actions">
          <button type="button" className="dash-btn-ghost" onClick={onClose} disabled={deleting}>
            {ar ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="dash-btn-gold"
            style={{ background: '#9a3b2f', borderColor: '#9a3b2f' }}
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? (ar ? 'جارٍ الإزالة…' : 'Removing…') : ar ? 'إزالة' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SetPasswordModal({
  companyId,
  member,
  ar,
  displayName,
  onClose,
}: {
  companyId: string;
  member: Member;
  ar: boolean;
  displayName: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError(
        ar
          ? 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.'
          : 'Password must be at least 8 characters.'
      );
      return;
    }
    if (password !== confirm) {
      setError(ar ? 'كلمتا المرور غير متطابقتين.' : 'Passwords do not match.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(
        `/api/companies/${companyId}/employees/${member.userId}/password`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || (ar ? 'تعذّر الحفظ.' : 'Could not save.'));
        setSaving(false);
        return;
      }
      setDone(true);
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
      setSaving(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ar ? 'تعيين كلمة مرور' : 'Set password'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {ar ? 'تعيين كلمة مرور' : 'Set password'}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={ar ? 'إغلاق' : 'Close'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {done ? (
          <>
            <div className="dash-alert dash-alert-ok" role="status" style={{ marginBottom: 16 }}>
              {ar ? 'تم تعيين كلمة المرور' : 'Password set'}
            </div>
            <p className="dash-subtitle" style={{ margin: '0 0 16px' }}>
              {ar
                ? `يمكن الآن لـ«${displayName}» تسجيل الدخول باستخدام بريده الإلكتروني (${member.email}) وكلمة المرور هذه.`
                : `“${displayName}” can now sign in with their email (${member.email}) and this password.`}
            </p>
            <div className="dash-modal-actions">
              <button type="button" className="dash-btn-gold" onClick={onClose}>
                {ar ? 'تم' : 'Done'}
              </button>
            </div>
          </>
        ) : (
          <>
            {error && (
              <div className="dash-alert dash-alert-error" role="alert">
                {error}
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-pw">
                  {ar ? 'كلمة المرور الجديدة' : 'New password'}
                </label>
                <input
                  id="emp-pw"
                  className="dash-input"
                  type="password"
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="emp-pw-confirm">
                  {ar ? 'تأكيد كلمة المرور' : 'Confirm password'}
                </label>
                <input
                  id="emp-pw-confirm"
                  className="dash-input"
                  type="password"
                  dir="ltr"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>

              <p className="dash-subtitle" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
                {ar
                  ? `يتيح هذا لـ«${displayName}» تسجيل الدخول باستخدام بريده الإلكتروني (${member.email}) وكلمة المرور هذه (8 أحرف على الأقل). يؤدي هذا إلى إنهاء أي جلسات مفتوحة له.`
                  : `This lets “${displayName}” sign in with their email (${member.email}) and this password (min 8 characters). Any existing sessions of theirs will be signed out.`}
              </p>

              <div className="dash-modal-actions">
                <button type="button" className="dash-btn-ghost" onClick={onClose} disabled={saving}>
                  {ar ? 'إلغاء' : 'Cancel'}
                </button>
                <button type="submit" className="dash-btn-gold" disabled={saving}>
                  {saving ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : ar ? 'حفظ' : 'Save'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const smallBtn: CSSProperties = {
  padding: '5px 12px',
  fontSize: 13,
};

function avatarStyle(bg: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: bg,
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  };
}

function roleTagStyle(color: string): CSSProperties {
  return {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    background: `${color}1f`,
    color,
    border: `1px solid ${color}55`,
  };
}
