'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useDash } from './DashboardShell';

/**
 * Contacts (CRM) screen — Phase 8. Active-company scoped: reads the active
 * company from the shell context and lists /api/companies/[id]/contacts (the
 * server re-enforces company isolation). ADMIN does everything (add / edit /
 * delete); a MANAGER may add and edit; an EMPLOYEE may do whatever
 * 'company.contacts' / 'company.contactsAdd' / 'company.contactsEdit' were
 * granted. Deleting is admin-only and is not a grantable capability.
 *
 * Bilingual + RTL via useDash().lang (inline strings — no new i18n keys).
 * Each contact carries an Arabic AND an English name/note plus an international
 * phone key (country code + local number). The table shows the current-language
 * variant, falling back to the other language or the legacy `name`.
 */

interface Contact {
  id: string;
  name: string; // legacy single-language column (fallback only)
  nameEn: string;
  nameAr: string;
  phone: string;
  phoneCountryCode: string;
  email: string;
  notes: string; // legacy single-language column (fallback only)
  notesEn: string;
  notesAr: string;
  createdAt: string;
}

/** International dialing codes offered in the Add/Edit forms. Default: Qatar. */
const PHONE_CODES: { code: string; ar: string; en: string }[] = [
  { code: '+974', ar: 'قطر', en: 'Qatar' },
  { code: '+966', ar: 'السعودية', en: 'Saudi Arabia' },
  { code: '+971', ar: 'الإمارات', en: 'UAE' },
  { code: '+965', ar: 'الكويت', en: 'Kuwait' },
  { code: '+973', ar: 'البحرين', en: 'Bahrain' },
  { code: '+968', ar: 'عُمان', en: 'Oman' },
  { code: '+20', ar: 'مصر', en: 'Egypt' },
  { code: '+962', ar: 'الأردن', en: 'Jordan' },
  { code: '+961', ar: 'لبنان', en: 'Lebanon' },
  { code: '+1', ar: 'الولايات المتحدة/كندا', en: 'USA/Canada' },
  { code: '+44', ar: 'المملكة المتحدة', en: 'UK' },
];
const DEFAULT_PHONE_CODE = '+974';

/** Current-language display name with graceful fallback to the other lang / legacy. */
function displayName(c: Contact, ar: boolean): string {
  const primary = ar ? c.nameAr : c.nameEn;
  const secondary = ar ? c.nameEn : c.nameAr;
  return primary || secondary || c.name || '';
}
function displayNotes(c: Contact, ar: boolean): string {
  const primary = ar ? c.notesAr : c.notesEn;
  const secondary = ar ? c.notesEn : c.notesAr;
  return primary || secondary || c.notes || '';
}

// A calm, on-brand palette for the initial avatars (deterministic per name).
const AVATAR_COLORS = ['#BD9446', '#6E8B74', '#8A6E5A', '#5B6E8C', '#96707A', '#7A7A5B'];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initial(name: string): string {
  const t = name.trim();
  return t ? t[0].toUpperCase() : '?';
}

export default function ContactsView() {
  const { lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';
  // THREE SEPARATE POWERS, because the server treats them separately:
  //   add    — admin, any manager, or 'company.contactsAdd'
  //   edit   — admin, any manager, or 'company.contactsEdit'
  //   delete — admin ONLY, and deliberately not grantable
  // Hence three flags rather than one "canManage". Every one of these is
  // re-checked in the route; a wrong flag costs a button that returns 403.
  const canDelete = activeCompany?.role === 'admin';
  const isManager =
    activeCompany?.role === 'admin' || activeCompany?.isManager === true;
  const [addGrant, setAddGrant] = useState(false);
  const [editGrant, setEditGrant] = useState(false);
  const canAdd = isManager || addGrant;
  const canEdit = isManager || editGrant;
  const showActions = canEdit || canDelete;

  useEffect(() => {
    if (!companyId || isManager) {
      setAddGrant(false);
      setEditGrant(false);
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
          setAddGrant(data.capabilities.includes('company.contactsAdd'));
          setEditGrant(data.capabilities.includes('company.contactsEdit'));
        }
      } catch {
        /* keep false — the API refuses the write anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, isManager]);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) {
      setContacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/contacts`, { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        contacts?: Contact[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.contacts)) {
        setError(ar ? 'تعذّر تحميل جهات الاتصال.' : 'Could not load contacts.');
        setContacts([]);
      } else {
        setContacts(data.contacts);
      }
    } catch {
      setError(ar ? 'تعذّر تحميل جهات الاتصال.' : 'Could not load contacts.');
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [companyId, ar]);

  useEffect(() => {
    load();
  }, [load]);

  function onSaved(saved: Contact) {
    setContacts((prev) => {
      const exists = prev.some((c) => c.id === saved.id);
      return exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...prev];
    });
    setEditing(null);
  }

  async function onDelete(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && data.ok) {
        setContacts((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError(ar ? 'تعذّر الحذف.' : 'Could not delete.');
      }
    } catch {
      setError(ar ? 'تعذّر الحذف.' : 'Could not delete.');
    } finally {
      setDeleting(null);
    }
  }

  if (!activeCompany) {
    return (
      <>
        <h1 className="dash-title">{'CRM'}</h1>
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
          <h1 className="dash-title">{'CRM'}</h1>
          <p className="dash-subtitle">
            {ar ? activeCompany.nameAr : activeCompany.nameEn}
          </p>
        </div>
        {canAdd && (
          <button type="button" className="dash-btn-gold" onClick={() => setEditing('new')}>
            + {ar ? 'إضافة جهة اتصال' : 'Add contact'}
          </button>
        )}
      </div>

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
      ) : contacts.length === 0 ? (
        <div className="dash-card dash-state-card">
          <p className="dash-subtitle" style={{ margin: 0 }}>
            {ar ? 'لا توجد جهات اتصال بعد.' : 'No contacts yet.'}
          </p>
        </div>
      ) : (
        <div className="dash-card" style={{ padding: 0 }}>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>{ar ? 'الاسم' : 'Name'}</th>
                  <th>{ar ? 'الهاتف' : 'Phone'}</th>
                  <th>{ar ? 'البريد الإلكتروني' : 'Email'}</th>
                  <th>{ar ? 'ملاحظات' : 'Notes'}</th>
                  {showActions && <th style={{ width: 1 }} aria-label="actions" />}
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => {
                  const nm = displayName(c, ar);
                  const nt = displayNotes(c, ar);
                  return (
                    <tr key={c.id}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <span style={avatarStyle(avatarColor(nm))} aria-hidden="true">
                            {initial(nm)}
                          </span>
                          <span style={{ fontWeight: 600 }}>{nm || '—'}</span>
                        </span>
                      </td>
                      <td className="dash-td-muted" dir="ltr" style={{ textAlign: ar ? 'right' : 'left' }}>
                        {c.phone ? `${c.phoneCountryCode || DEFAULT_PHONE_CODE} ${c.phone}` : '—'}
                      </td>
                      <td className="dash-td-muted" dir="ltr" style={{ textAlign: ar ? 'right' : 'left' }}>
                        {c.email || '—'}
                      </td>
                      <td className="dash-td-muted">{nt || '—'}</td>
                      {showActions && (
                        <td>
                          <span style={{ display: 'inline-flex', gap: 8, whiteSpace: 'nowrap' }}>
                            {canEdit && (
                              <button
                                type="button"
                                className="dash-btn-ghost"
                                style={smallBtn}
                                onClick={() => setEditing(c)}
                              >
                                {ar ? 'تعديل' : 'Edit'}
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                className="dash-btn-ghost"
                                style={{ ...smallBtn, color: '#9a3b2f' }}
                                disabled={deleting === c.id}
                                onClick={() => onDelete(c.id)}
                              >
                                {deleting === c.id ? '…' : ar ? 'حذف' : 'Delete'}
                              </button>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && companyId && (
        <ContactModal
          companyId={companyId}
          contact={editing === 'new' ? null : editing}
          ar={ar}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function ContactModal({
  companyId,
  contact,
  ar,
  onClose,
  onSaved,
}: {
  companyId: string;
  contact: Contact | null;
  ar: boolean;
  onClose: () => void;
  onSaved: (c: Contact) => void;
}) {
  const [nameAr, setNameAr] = useState(contact?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(contact?.nameEn ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [phoneCode, setPhoneCode] = useState(contact?.phoneCountryCode || DEFAULT_PHONE_CODE);
  const [email, setEmail] = useState(contact?.email ?? '');
  const [notesAr, setNotesAr] = useState(contact?.notesAr ?? '');
  const [notesEn, setNotesEn] = useState(contact?.notesEn ?? '');
  const [error, setError] = useState<string | null>(null);
  /** Set when the contact was NOT created but parked for an approving manager. */
  const [held, setHeld] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = contact !== null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameAr.trim() && !nameEn.trim()) {
      setError(ar ? 'الاسم مطلوب (عربي أو إنجليزي).' : 'A name is required (Arabic or English).');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const url = isEdit ? `/api/contacts/${contact!.id}` : `/api/companies/${companyId}/contacts`;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name_ar: nameAr,
          name_en: nameEn,
          phone,
          phone_country_code: phoneCode,
          email,
          notes_ar: notesAr,
          notes_en: notesEn,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
        messageAr?: string;
        contact?: Contact;
      };
      // 202 — the grant behind this write ('company.contactsAdd' when adding,
      // 'company.contactsEdit' when editing) was handed out in "requires
      // approval" form. The directory is unchanged until the approver says yes.
      if (res.status === 202 && data.code === 'pending_approval') {
        setHeld(
          (ar ? data.messageAr : data.message) ||
            (ar ? 'أُرسل الطلب إلى المدير المعتمد.' : 'Sent to your approving manager.')
        );
        setSaving(false);
        return;
      }
      if (!res.ok || !data.ok || !data.contact) {
        setError(data.error || (ar ? 'تعذّر الحفظ.' : 'Could not save.'));
        setSaving(false);
        return;
      }
      onSaved(data.contact);
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
      aria-label={isEdit ? (ar ? 'تعديل جهة اتصال' : 'Edit contact') : ar ? 'إضافة جهة اتصال' : 'Add contact'}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {isEdit
              ? ar
                ? 'تعديل جهة اتصال'
                : 'Edit contact'
              : ar
              ? 'إضافة جهة اتصال'
              : 'Add contact'}
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

        {held && (
          <div className="dash-alert" role="status">
            {held}
          </div>
        )}
        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-name-ar">
              {ar ? 'الاسم (بالعربية)' : 'Name (Arabic)'}
            </label>
            <input
              id="ct-name-ar"
              className="dash-input"
              dir="rtl"
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
            />
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-name-en">
              {ar ? 'الاسم (بالإنجليزية)' : 'Name (English)'}
            </label>
            <input
              id="ct-name-en"
              className="dash-input"
              dir="ltr"
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
            />
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-phone">
              {ar ? 'الهاتف' : 'Phone'}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }} dir="ltr">
              <select
                aria-label={ar ? 'رمز الدولة' : 'Country code'}
                className="dash-input"
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                style={{ flex: '0 0 auto', width: 'auto', minWidth: 96 }}
              >
                {PHONE_CODES.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} {ar ? p.ar : p.en}
                  </option>
                ))}
              </select>
              <input
                id="ct-phone"
                className="dash-input"
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                style={{ flex: '1 1 auto', minWidth: 0 }}
              />
            </div>
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-email">
              {ar ? 'البريد الإلكتروني' : 'Email'}
            </label>
            <input
              id="ct-email"
              className="dash-input"
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-notes-ar">
              {ar ? 'ملاحظات (بالعربية)' : 'Note (Arabic)'}
            </label>
            <textarea
              id="ct-notes-ar"
              className="dash-input"
              dir="rtl"
              rows={3}
              value={notesAr}
              onChange={(e) => setNotesAr(e.target.value)}
              style={{ resize: 'vertical' }}
            />
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ct-notes-en">
              {ar ? 'ملاحظات (بالإنجليزية)' : 'Note (English)'}
            </label>
            <textarea
              id="ct-notes-en"
              className="dash-input"
              dir="ltr"
              rows={3}
              value={notesEn}
              onChange={(e) => setNotesEn(e.target.value)}
              style={{ resize: 'vertical' }}
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

const smallBtn: CSSProperties = {
  padding: '5px 12px',
  fontSize: 13,
};
