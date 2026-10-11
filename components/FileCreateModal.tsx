'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { CASE_LEVELS, isKnownCaseLevel } from '../lib/caseLevels';
import type { ClientFile, ClientFolderType } from './FilesView';
import type { ClientFolderTypeRecord } from './ManageFolderTypesModal';
import { fetchFolderTypes } from './folderTypesCache';

/** A CRM contact as returned by GET /api/companies/[id]/contacts. */
interface CrmContact {
  id: string;
  name: string;
  nameEn: string;
  nameAr: string;
}

/** A company member as returned by GET /api/companies/[id]/employees. */
interface CompanyMember {
  userId: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string;
}

/**
 * Create-file dialog (Phase 2). ADMIN-ONLY — the shell only renders the trigger
 * for admins and POST /api/files re-enforces it (non-admins get 403). Only
 * `potential` and `active` are creatable; `expired` is reached via a move.
 *
 * The CLIENT is CHOSEN from the active company's CRM contacts (no free typing).
 *
 * The FOLDER TYPE (first field) decides the rest of the form:
 *   • Case / قضية    → client + bilingual OPPONENT + folder leader.
 *   • Contract / عقد → client + folder leader ONLY; the opponent fields are not
 *     rendered, not required and not submitted.
 * It defaults to Case, which is what every folder was before this existed.
 */
export default function FileCreateModal({
  companyId,
  onClose,
  onCreated,
}: {
  companyId: string;
  onClose: () => void;
  onCreated: (file: ClientFile) => void;
}) {
  const { t, lang } = useDash();
  const [folderType, setFolderType] = useState<ClientFolderType>('case');
  const [folderTypes, setFolderTypes] = useState<ClientFolderTypeRecord[]>([]);
  const [clientContactId, setClientContactId] = useState('');
  const [opponentAr, setOpponentAr] = useState('');
  const [opponentEn, setOpponentEn] = useState('');
  const [folderLeaderId, setFolderLeaderId] = useState('');
  const [section, setSection] = useState<'potential' | 'active'>('potential');
  const [driveLink, setDriveLink] = useState('');
  // Case identity. Only meaningful for a CASE-layout folder — a contract has no
  // court and no case number — so these are hidden for a contract and never
  // sent, mirroring how the opponent is handled.
  const [caseNumber, setCaseNumber] = useState('');
  const [court, setCourt] = useState('');
  const [caseLevel, setCaseLevel] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Set when the folder was NOT created but parked for an approving manager. */
  const [held, setHeld] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // CRM contacts for the client dropdown.
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsError, setContactsError] = useState(false);

  // Company members for the folder-leader dropdown.
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState(false);

  const contactLabel = useCallback(
    (c: CrmContact) =>
      (lang === 'ar' ? c.nameAr || c.nameEn : c.nameEn || c.nameAr) ||
      c.name ||
      '—',
    [lang]
  );

  const memberLabel = useCallback(
    (m: CompanyMember) =>
      (lang === 'ar' ? m.nameAr || m.nameEn : m.nameEn || m.nameAr) ||
      m.email ||
      '—',
    [lang]
  );

  // Shared cache — see components/folderTypesCache.ts.
  useEffect(() => {
    let cancelled = false;
    fetchFolderTypes()
      .then((types) => {
        if (!cancelled) setFolderTypes(types);
      })
      .catch(() => {
        /* the "case"/"contract" fallback options below still work */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setContactsLoading(true);
      setContactsError(false);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/contacts`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          contacts?: CrmContact[];
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !Array.isArray(data.contacts)) {
          setContactsError(true);
          setContacts([]);
        } else {
          setContacts(data.contacts);
        }
      } catch {
        if (!cancelled) setContactsError(true);
      } finally {
        if (!cancelled) setContactsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMembersLoading(true);
      setMembersError(false);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/employees`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          members?: CompanyMember[];
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !Array.isArray(data.members)) {
          setMembersError(true);
          setMembers([]);
        } else {
          setMembers(data.members);
        }
      } catch {
        if (!cancelled) setMembersError(true);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const noContacts = !contactsLoading && !contactsError && contacts.length === 0;
  const noMembers = !membersLoading && !membersError && members.length === 0;
  const selectedType = folderTypes.find((ft) => ft.key === folderType);
  // Fallback to the literal check for the instant before folder-types loads.
  const isContract = selectedType
    ? selectedType.layout === 'contract'
    : folderType === 'contract';
  // A contract needs no opponent; a case still requires at least one language.
  const canSubmit =
    !saving &&
    !!clientContactId &&
    (isContract ||
      opponentAr.trim().length > 0 ||
      opponentEn.trim().length > 0) &&
    !!folderLeaderId;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          folder_type: folderType,
          client_contact_id: clientContactId,
          // A contract sends NO opponent at all (the server also ignores it).
          ...(isContract
            ? {}
            : {
                opponent_ar: opponentAr.trim(),
                opponent_en: opponentEn.trim(),
              }),
          folder_leader_id: folderLeaderId,
          section,
          drive_link: driveLink,
          ...(isContract
            ? {}
            : {
                case_number: caseNumber.trim(),
                court: court.trim(),
                case_level: caseLevel.trim(),
              }),
          comment: comment.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
        messageAr?: string;
        file?: ClientFile;
      };
      // 202 — 'files.create' was granted as a "requires approval" permission.
      // No folder exists yet, so there is nothing to hand to onCreated; the
      // modal reports that it was sent and stays put.
      if (res.status === 202 && data.code === 'pending_approval') {
        setHeld(
          (lang === 'ar' ? data.messageAr : data.message) ||
            (lang === 'ar'
              ? 'أُرسل الطلب إلى المدير المعتمد.'
              : 'Sent to your approving manager.')
        );
        setSaving(false);
        return;
      }
      if (!res.ok || !data.ok || !data.file) {
        setError(data.error || t.couldNotSaveFile);
        setSaving(false);
        return;
      }
      onCreated(data.file);
    } catch {
      setError(t.networkError);
      setSaving(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t.createFileTitle}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {t.createFileTitle}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={t.close}
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
          {/* FOLDER TYPE — first, because it decides which fields follow. */}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-type">
              {lang === 'ar' ? 'نوع الملف' : 'Folder type'}
            </label>
            <select
              id="cf-type"
              className="dash-input"
              value={folderType}
              onChange={(e) =>
                setFolderType(e.target.value as ClientFolderType)
              }
            >
              {folderTypes.length > 0 ? (
                folderTypes.map((ft) => (
                  <option key={ft.key} value={ft.key}>
                    {lang === 'ar' ? ft.labelAr : ft.labelEn}
                  </option>
                ))
              ) : (
                <>
                  <option value="case">
                    {lang === 'ar' ? 'قضية' : 'Case'}
                  </option>
                  <option value="contract">
                    {lang === 'ar' ? 'عقد' : 'Contract'}
                  </option>
                </>
              )}
            </select>
            <p className="dash-hint" style={{ margin: '6px 0 0' }}>
              {lang === 'ar'
                ? isContract
                  ? 'عقد: الموكّل فقط، بدون خصم.'
                  : 'قضية: الموكّل والخصم.'
                : isContract
                ? 'Contract: client only, no opponent.'
                : 'Case: client and opponent.'}
            </p>
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-client">
              {t.fileClient}
            </label>
            <select
              id="cf-client"
              className="dash-input"
              value={clientContactId}
              onChange={(e) => setClientContactId(e.target.value)}
              disabled={contactsLoading || noContacts}
              required
            >
              <option value="">
                {contactsLoading
                  ? '…'
                  : lang === 'ar'
                  ? 'اختر جهة اتصال…'
                  : 'Select a contact…'}
              </option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {contactLabel(c)}
                </option>
              ))}
            </select>
            {noContacts && (
              <p className="dash-hint" style={{ margin: '6px 0 0' }}>
                {lang === 'ar'
                  ? 'أضف جهة اتصال في CRM أولاً.'
                  : 'Add a contact in CRM first.'}
              </p>
            )}
            {contactsError && (
              <p className="dash-hint" style={{ margin: '6px 0 0' }}>
                {t.networkError}
              </p>
            )}
          </div>

          {/* OPPONENT — a CASE only. A contract has no adversary. */}
          {!isContract && (
            <>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="cf-opponent-ar">
                  {lang === 'ar' ? 'الخصم (بالعربية)' : 'Opponent (Arabic)'}
                </label>
                <input
                  id="cf-opponent-ar"
                  className="dash-input"
                  dir="rtl"
                  value={opponentAr}
                  onChange={(e) => setOpponentAr(e.target.value)}
                  placeholder={t.fileOpponentPlaceholder}
                />
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="cf-opponent-en">
                  {lang === 'ar' ? 'الخصم (بالإنجليزية)' : 'Opponent (English)'}
                </label>
                <input
                  id="cf-opponent-en"
                  className="dash-input"
                  dir="ltr"
                  value={opponentEn}
                  onChange={(e) => setOpponentEn(e.target.value)}
                  placeholder="e.g. Beta Holdings"
                />
              </div>
            </>
          )}

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-lawyer">
              {t.fileManagingLawyer}
            </label>
            <select
              id="cf-lawyer"
              className="dash-input"
              value={folderLeaderId}
              onChange={(e) => setFolderLeaderId(e.target.value)}
              disabled={membersLoading || noMembers}
              required
            >
              <option value="">
                {membersLoading
                  ? '…'
                  : lang === 'ar'
                  ? 'اختر عضوًا…'
                  : 'Select a member…'}
              </option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
            {noMembers && (
              <p className="dash-hint" style={{ margin: '6px 0 0' }}>
                {lang === 'ar'
                  ? 'أضف عضوًا إلى الشركة أولاً.'
                  : 'Add a member to the company first.'}
              </p>
            )}
            {membersError && (
              <p className="dash-hint" style={{ margin: '6px 0 0' }}>
                {t.networkError}
              </p>
            )}
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-section">
              {t.fileSection}
            </label>
            <select
              id="cf-section"
              className="dash-input"
              value={section}
              onChange={(e) =>
                setSection(e.target.value as 'potential' | 'active')
              }
            >
              <option value="potential">{t.sectionPotential}</option>
              <option value="active">{t.sectionActive}</option>
            </select>
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-drive">
              {t.fileDriveLink}{' '}
              <span className="dash-hint" style={{ display: 'inline' }}>
                {t.optionalTag}
              </span>
            </label>
            <input
              id="cf-drive"
              className="dash-input"
              type="url"
              dir="ltr"
              value={driveLink}
              onChange={(e) => setDriveLink(e.target.value)}
              placeholder={t.fileDriveLinkPlaceholder}
            />
          </div>

          {!isContract && (
            <>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="cf-case-number">
                  {t.fileCaseNumber}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <input
                  id="cf-case-number"
                  className="dash-input"
                  value={caseNumber}
                  onChange={(e) => setCaseNumber(e.target.value)}
                  placeholder={t.fileCaseNumberPlaceholder}
                  maxLength={120}
                />
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="cf-court">
                  {t.fileCourt}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <input
                  id="cf-court"
                  className="dash-input"
                  value={court}
                  onChange={(e) => setCourt(e.target.value)}
                  placeholder={t.fileCourtPlaceholder}
                  maxLength={120}
                />
              </div>

              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="cf-case-level">
                  {t.fileCaseLevel}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <select
                  id="cf-case-level"
                  className="dash-input"
                  value={caseLevel}
                  onChange={(e) => setCaseLevel(e.target.value)}
                >
                  <option value="">{t.caseLevelNone}</option>
                  {CASE_LEVELS.map((level) => (
                    <option key={level.key} value={level.key}>
                      {lang === 'ar' ? level.ar : level.en}
                    </option>
                  ))}
                  {/* A value typed before this list existed. Offered so the
                      field is not silently blanked on a file nobody has
                      edited — the reader can see what it says and correct it. */}
                  {caseLevel && !isKnownCaseLevel(caseLevel) ? (
                    <option value={caseLevel}>{caseLevel}</option>
                  ) : null}
                </select>
              </div>
            </>
          )}

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="cf-comment">
              {t.fileComment}{' '}
              <span className="dash-hint" style={{ display: 'inline' }}>
                {t.optionalTag}
              </span>
            </label>
            <textarea
              id="cf-comment"
              className="dash-input"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder={t.fileCommentPlaceholder}
            />
          </div>

          <div className="dash-modal-actions">
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              className="dash-btn-gold"
              disabled={!canSubmit}
            >
              {saving ? t.saving : t.createFileTitle}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
