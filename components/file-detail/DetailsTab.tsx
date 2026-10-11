'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from '../DashboardShell';
import { CASE_LEVELS, caseLevelLabel, isKnownCaseLevel } from '@/lib/caseLevels';
import {
  FILE_SECTIONS,
  FILE_STATUS_PALETTE,
  SECTION_START_COLOR,
  type FileSection,
  type FileStatusColorName,
} from '@/lib/platform/fileColors';
import { SECTION_LADDER } from '@/lib/platform/colorEngine';
import { formatDate } from '@/lib/format';
import {
  fileClientName,
  fileOpponentName,
  fileFolderLeaderName,
  type ClientFile,
  type ClientFolderType,
} from '../FilesView';
import type { ClientFolderTypeRecord } from '../ManageFolderTypesModal';
import DeleteFolderConfirm from './DeleteFolderConfirm';
import {
  colorName,
  initialOf,
  type AccessPerson,
  type CompanyMember,
  type CrmContact,
  type FileDetailProps,
  type PendingItem,
} from './types';
import type { FileTasksState } from './useFileTasks';
import { fetchFolderTypes } from '../folderTypesCache';

/**
 * The folder's facts and controls — the first tab of the folder drawer:
 * the info grid (and the admin edit form behind it), who has access, the colour
 * step bar, the move control, and the danger zone.
 *
 * It also carries the ON-LEAVE warning: leave does not pause the task clock, so
 * an open task held by someone who is away needs a human to reassign it, and
 * this is where that is said.
 */
export default function DetailsTab({
  file,
  canMove,
  canManageAccess,
  canEditCore,
  canEditCaseDetails,
  canDeleteFile,
  onMoved,
  onTasksChanged,
  onDeleted,
  tasksState,
}: Omit<
  FileDetailProps,
  | 'onClose'
  | 'canCreateTask'
  | 'canEditTask'
  | 'canPushBack'
  // Task permissions belong to the Tasks tab; this one never renders a task
  // control, so it must not demand the props for them.
  | 'canDeleteTask'
> & {
  tasksState: FileTasksState;
}) {
  const { t, lang, activeCompany } = useDash();
  // The general folder is a company-wide access decision, so only an admin may
  // set it — matching the server, which refuses anyone else.
  const isAdmin = activeCompany?.role === 'admin';
  /**
   * Pinning is admin OR manager — one step wider than the general folder,
   * because any number of folders may be pinned and it is a routine act, where
   * designating THE single general folder is a once-a-year decision. The server
   * enforces the same rule; this only decides whether the control is drawn.
   */
  const canPin = isAdmin || activeCompany?.role === 'manager';

  const [target, setTarget] = useState<FileSection>(file.section);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Delete folder — opens the type-to-confirm guard. ──
  const [showDelete, setShowDelete] = useState(false);

  // ── Core-info edit ──
  const [editing, setEditing] = useState(false);
  // Folder type drives which core fields the form shows — a 'contract'-layout
  // type has no opponent, a 'case'-layout type keeps the client-vs-opponent pair.
  const [editFolderType, setEditFolderType] = useState<ClientFolderType>(
    file.folderType
  );
  const [folderTypes, setFolderTypes] = useState<ClientFolderTypeRecord[]>([]);
  const [editClientContactId, setEditClientContactId] = useState(
    file.clientContactId ?? ''
  );
  const [editOpponentAr, setEditOpponentAr] = useState(file.opponentAr);
  const [editOpponentEn, setEditOpponentEn] = useState(file.opponentEn);
  const [editFolderLeaderId, setEditFolderLeaderId] = useState(
    file.folderLeaderId ?? ''
  );
  const [editDrive, setEditDrive] = useState(file.driveLink ?? '');
  const [editCaseNumber, setEditCaseNumber] = useState(file.caseNumber ?? '');
  const [editCourt, setEditCourt] = useState(file.court ?? '');
  const [editCaseLevel, setEditCaseLevel] = useState(file.caseLevel ?? '');
  const [editIsGeneral, setEditIsGeneral] = useState(file.isGeneral === true);
  const [editIsPinned, setEditIsPinned] = useState(file.isPinned === true);
  const [editFolderType2, setEditFolderType2] = useState(file.folderType2 ?? '');
  const [savingCore, setSavingCore] = useState(false);
  const [coreErr, setCoreErr] = useState<string | null>(null);

  // CRM contacts for the client dropdown (loaded only for those who can edit).
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState(false);

  // Company members for the folder-leader dropdown.
  const [folderLeaderMembers, setFolderLeaderMembers] = useState<CompanyMember[]>(
    []
  );
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState(false);

  // ── Access section state ──
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessLoadError, setAccessLoadError] = useState(false);
  /** Refused (403/404) rather than failed — see the note in loadAccess. */
  const [accessRefused, setAccessRefused] = useState(false);
  const [members, setMembers] = useState<AccessPerson[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [assignable, setAssignable] = useState<AccessPerson[]>([]);
  /** Employees staged for the NEXT "Request to add" click — lets one click
   * send requests for several people instead of one at a time. */
  const [pickedEmployees, setPickedEmployees] = useState<string[]>([]);
  const [requesting, setRequesting] = useState(false);
  const [accessMsg, setAccessMsg] = useState<string | null>(null);
  const [accessErr, setAccessErr] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Forced-reassignment: when removing a member with open tasks, we ask who
  // inherits them. Holds the member being removed + the chosen replacement.
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');

  const contactLabel = useCallback(
    (c: CrmContact) =>
      (lang === 'ar' ? c.nameAr || c.nameEn : c.nameEn || c.nameAr) || c.name || '—',
    [lang]
  );

  const memberLabel = useCallback(
    (m: CompanyMember) =>
      (lang === 'ar' ? m.nameAr || m.nameEn : m.nameEn || m.nameAr) || m.email || '—',
    [lang]
  );

  const personName = useCallback(
    (p: AccessPerson) =>
      (lang === 'ar' ? p.fullNameAr : p.fullNameEn) || p.fullNameEn || p.username,
    [lang]
  );

  const sectionLabel = (s: FileSection) =>
    s === 'potential'
      ? t.sectionPotential
      : s === 'active'
      ? t.sectionActive
      : s === 'expired'
      ? t.sectionExpired
      : t.sectionAttrition;

  const sectionColor = SECTION_START_COLOR[file.section];

  // The edit form's folder-type dropdown's RESOLVED layout — drives whether the
  // opponent fields show, once folderTypes has loaded (falls back to the
  // literal 'contract' key for the instant before it does).
  const editSelectedTypeForRender = folderTypes.find(
    (ft) => ft.key === editFolderType
  );
  const editIsContractForRender = editSelectedTypeForRender
    ? editSelectedTypeForRender.layout === 'contract'
    : editFolderType === 'contract';

  // The ladder to render in the step bar. A green (closed) file — expired, or
  // no open tasks — shows a single green segment regardless of its section.
  const ladderKeys: FileStatusColorName[] =
    file.color.colorKey === 'green' ? ['green'] : SECTION_LADDER[file.section];
  const stepIndex = file.color.stepIndex;

  const loadAccess = useCallback(async () => {
    setAccessLoading(true);
    setAccessLoadError(false);
    setAccessRefused(false);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/access`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: AccessPerson[];
        pending?: PendingItem[];
        assignableEmployees?: AccessPerson[];
      };
      if (!res.ok || !data.ok) {
        // Refused, not broken: reading who is on a folder is gated on being
        // able to MANAGE that list. An employee who cannot is not looking at a
        // fault, so the section says nothing rather than showing a red box.
        setAccessRefused(res.status === 403 || res.status === 404);
        setAccessLoadError(!(res.status === 403 || res.status === 404));
        setMembers([]);
        setPending([]);
        setAssignable([]);
      } else {
        setAccessRefused(false);
        setMembers(Array.isArray(data.members) ? data.members : []);
        setPending(Array.isArray(data.pending) ? data.pending : []);
        const nextAssignable = Array.isArray(data.assignableEmployees)
          ? data.assignableEmployees
          : [];
        setAssignable(nextAssignable);
        // Drop any staged pick that is no longer assignable (it went through,
        // or someone else already added/requested them) so it can't be resent.
        const stillAssignable = new Set(nextAssignable.map((e) => e.userId));
        setPickedEmployees((prev) => prev.filter((id) => stillAssignable.has(id)));
      }
    } catch {
      setAccessLoadError(true);
    } finally {
      setAccessLoading(false);
    }
  }, [file.id]);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  // The company's CRM contacts, for the client dropdown.
  //
  // Deferred until the EDIT FORM IS OPEN. It only ever fills a <select> inside
  // that form, and fetching it on mount spent a round trip on every folder
  // anyone merely looked at — most of which are never edited.
  useEffect(() => {
    if (!canEditCore || !editing) return;
    let cancelled = false;
    (async () => {
      setContactsLoading(true);
      setContactsError(false);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(file.companyId)}/contacts`,
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
  }, [canEditCore, editing, file.companyId]);

  // The company's members, for the folder-leader dropdown. Deferred for the
  // same reason as the contacts above — it feeds one <select> in the edit form
  // and nothing in the read view. Best-effort: a viewer who cannot reach this
  // endpoint simply gets an empty picker.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    (async () => {
      setMembersLoading(true);
      setMembersError(false);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(file.companyId)}/employees`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          members?: CompanyMember[];
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !Array.isArray(data.members)) {
          setMembersError(true);
          setFolderLeaderMembers([]);
        } else {
          setFolderLeaderMembers(data.members);
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
  }, [editing, file.companyId]);

  // The folder-types list — needed for the read-only "Folder type" label (any
  // viewer) as well as the edit dropdown. Served from a shared cache: it is
  // one global list that four components used to fetch independently.
  useEffect(() => {
    let cancelled = false;
    fetchFolderTypes()
      .then((types) => {
        if (!cancelled) setFolderTypes(types);
      })
      .catch(() => {
        /* the label falls back to the stored key */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openEdit() {
    // Pre-fill from the current file each time the form opens.
    setEditFolderType(file.folderType);
    setEditClientContactId(file.clientContactId ?? '');
    setEditOpponentAr(file.opponentAr);
    setEditOpponentEn(file.opponentEn);
    setEditFolderLeaderId(file.folderLeaderId ?? '');
    setEditDrive(file.driveLink ?? '');
    setEditCaseNumber(file.caseNumber ?? '');
    setEditCourt(file.court ?? '');
    setEditCaseLevel(file.caseLevel ?? '');
    setEditIsGeneral(file.isGeneral === true);
    setEditIsPinned(file.isPinned === true);
    setEditFolderType2(file.folderType2 ?? '');
    setCoreErr(null);
    setEditing(true);
  }

  async function onSaveCore(e: React.FormEvent) {
    e.preventDefault();
    const editSelectedType = folderTypes.find((ft) => ft.key === editFolderType);
    const editIsContract = editSelectedType
      ? editSelectedType.layout === 'contract'
      : editFolderType === 'contract';
    const opponentAr = editOpponentAr.trim();
    const opponentEn = editOpponentEn.trim();
    // Only applies to the CORE fields. Someone editing just the case details
    // never touches these, and a legacy folder with no linked contact would
    // otherwise block them from recording a case number.
    if (
      canEditCore &&
      (!editClientContactId ||
        (!editIsContract && !opponentAr && !opponentEn) ||
        !editFolderLeaderId)
    ) {
      setCoreErr(
        lang === 'ar'
          ? editIsContract
            ? 'يرجى اختيار الموكّل واختيار قائد الملف.'
            : 'يرجى اختيار الموكّل وتعبئة الخصم واختيار قائد الملف.'
          : editIsContract
          ? 'Please select a client and a folder leader.'
          : 'Please select a client, fill in opponent and select a folder leader.'
      );
      return;
    }
    setSavingCore(true);
    setCoreErr(null);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Each group of fields is sent ONLY by someone allowed to change it.
        // The server gates them separately, and sending one you may not change
        // fails the WHOLE request — so a manager saving a case number must not
        // also post the client back, even unchanged.
        body: JSON.stringify({
          ...(canEditCore
            ? {
                folder_type: editFolderType,
                client_contact_id: editClientContactId,
                // A contract sends no opponent; the server also CLEARS any
                // stored one so a case converted to a contract loses its "vs".
                ...(editIsContract
                  ? {}
                  : { opponent_ar: opponentAr, opponent_en: opponentEn }),
                folder_leader_id: editFolderLeaderId,
                drive_link: editDrive.trim() || null,
                // '' means "no second type" and is sent as null so an emptied
                // dropdown CLEARS the stored one rather than being ignored.
                //
                // The equality guard matters: the dropdown hides whichever
                // type is selected above, but changing the FIRST type to match
                // an already-chosen second leaves the two equal in state. The
                // database refuses that outright (files_folder_types_distinct),
                // so it is resolved here — the folder keeps one type, which is
                // what "both are Case" actually means.
                folder_type_2:
                  editFolderType2 && editFolderType2 !== editFolderType
                    ? editFolderType2
                    : null,
              }
            : {}),
          // Admin-only; sending it as a non-admin would be refused outright,
          // so it is omitted rather than sent and rejected.
          ...(isAdmin ? { is_general: editIsGeneral } : {}),
          // Admin OR manager — same reasoning, one role wider.
          ...(canPin ? { is_pinned: editIsPinned } : {}),
          // Like the opponent above: a contract has no case identity, and
          // converting a case into one must clear what was stored rather than
          // leave a court name attached to a contract.
          ...(canEditCaseDetails
            ? editIsContract
              ? { case_number: null, court: null, case_level: null }
              : {
                  case_number: editCaseNumber.trim() || null,
                  court: editCourt.trim() || null,
                  case_level: editCaseLevel.trim() || null,
                }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        file?: ClientFile;
      };
      if (!res.ok || !data.ok || !data.file) {
        setCoreErr(data.error || t.couldNotSaveFile);
        setSavingCore(false);
        return;
      }
      // Refresh the detail panel AND the parent list (folder title updates).
      onMoved(data.file);
      setEditing(false);
      setSavingCore(false);
    } catch {
      setCoreErr(t.networkError);
      setSavingCore(false);
    }
  }

  async function onMove() {
    if (target === file.section) return;
    setMoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: target }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        file?: ClientFile;
      };
      if (!res.ok || !data.ok || !data.file) {
        setError(data.error || t.couldNotSaveFile);
        setMoving(false);
        return;
      }
      onMoved(data.file);
      setMoving(false);
    } catch {
      setError(t.networkError);
      setMoving(false);
    }
  }

  /** One request per staged employee, sequentially (each is its own DB row —
   * running them one at a time keeps error attribution per-person simple). A
   * person whose request fails stays staged so nothing is silently dropped. */
  async function onRequestAdd() {
    if (pickedEmployees.length === 0) return;
    setRequesting(true);
    setAccessMsg(null);
    setAccessErr(null);
    const failed: string[] = [];
    let firstError: string | null = null;
    for (const userId of pickedEmployees) {
      try {
        const res = await fetch(
          `/api/files/${encodeURIComponent(file.id)}/access-requests`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
          }
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          failed.push(userId);
          firstError = firstError ?? data.error ?? t.networkError;
        }
      } catch {
        failed.push(userId);
        firstError = firstError ?? t.networkError;
      }
    }
    setRequesting(false);
    setPickedEmployees(failed);
    if (failed.length === 0) {
      setAccessMsg(
        pickedEmployees.length > 1 ? t.accessRequestsSent : t.accessRequestSent
      );
    } else if (failed.length < pickedEmployees.length) {
      setAccessErr(t.accessRequestsPartial);
    } else {
      setAccessErr(firstError);
    }
    // Refresh so the successfully-requested employees move into "pending".
    await loadAccess();
  }

  async function onRemove(userId: string, handOffTo?: string) {
    // A plain remove asks to confirm; a reassign-remove is already deliberate.
    if (!handOffTo && typeof window !== 'undefined') {
      if (!window.confirm(t.confirmRemoveEmployee)) return;
    }
    setRemovingId(userId);
    setAccessMsg(null);
    setAccessErr(null);
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(file.id)}/access/${encodeURIComponent(
          userId
        )}`,
        {
          method: 'DELETE',
          ...(handOffTo
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reassignTo: handOffTo }),
              }
            : {}),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.ok) {
        if (data.code === 'reassign_required') {
          // The employee owns open tasks — open the "hand tasks to" picker.
          setReassignFor(userId);
          setReassignTo('');
          setAccessErr(data.error || t.reassignPrompt);
          setRemovingId(null);
          return;
        }
        // Includes the bilingual last-person message from the server.
        setAccessErr(data.error || t.couldNotRemove);
        setRemovingId(null);
        return;
      }
      setRemovingId(null);
      setReassignFor(null);
      setReassignTo('');
      await loadAccess();
      // Reassigned tasks change ownership + badge — refresh both.
      await tasksState.reload();
      onTasksChanged();
    } catch {
      setAccessErr(t.networkError);
      setRemovingId(null);
    }
  }

  /**
   * Open tasks whose assignee is away right now, grouped ONE PER PERSON.
   *
   * Leave does NOT pause the task clock — the folder keeps ageing toward red —
   * so this warning is what prompts someone to hand the work over. But the fact
   * being reported is "this person is away", not "this task is stuck": repeating
   * the same name and the same return date once per task turns one piece of news
   * into a wall of near-identical red boxes. One banner per person, listing
   * their affected tasks.
   */
  const onLeaveWarnings = (() => {
    const byPerson = new Map<
      string,
      { name: string; until: string; titles: string[] }
    >();
    for (const tk of tasksState.tasks) {
      if (tk.status !== 'open' || !tk.assignee) continue;
      const who = tasksState.assignees.find((a) => a.userId === tk.assignee?.userId);
      if (!who?.onLeaveUntil) continue;
      const name =
        (lang === 'ar' ? who.fullNameAr : who.fullNameEn) ||
        who.fullNameEn ||
        who.fullNameAr ||
        who.username;
      const entry = byPerson.get(who.userId) ?? {
        name,
        until: who.onLeaveUntil,
        titles: [],
      };
      entry.titles.push(tk.title);
      byPerson.set(who.userId, entry);
    }
    return [...byPerson.entries()].map(([userId, v]) => ({ userId, ...v }));
  })();

  return (
    <>
      {error && (
        <div className="dash-alert dash-alert-error" role="alert">
          {error}
        </div>
      )}

      {onLeaveWarnings.map((w) => {
        const list = w.titles.map((x) => `“${x}”`).join('، ');
        const listEn = w.titles.map((x) => `“${x}”`).join(', ');
        const one = w.titles.length === 1;
        return (
          <div key={w.userId} className="dash-alert dash-alert-error" role="status" dir="auto">
            {lang === 'ar'
              ? `${w.name} في إجازة حتى ${w.until} — أسند ${
                  one ? 'المهمة' : 'المهام'
                } ${list} لموظف آخر.`
              : `${w.name} is on leave until ${w.until} — reassign ${
                  one ? 'the task' : 'these tasks'
                } ${listEn} to another employee.`}
          </div>
        );
      })}

      {/* Facts header — an editor gets an "Edit folder" toggle */}
      {(canEditCore || canEditCaseDetails) && (
        <div
          className="dash-page-head"
          style={{ marginBottom: 10, alignItems: 'center' }}
        >
          <div className="dash-eyebrow">
            {lang === 'ar' ? 'بيانات الملف' : 'Folder info'}
          </div>
          {!editing && (
            <button type="button" className="dash-btn-ghost" onClick={openEdit}>
              {lang === 'ar' ? 'تعديل الملف' : 'Edit folder'}
            </button>
          )}
        </div>
      )}

      {/* Core-info edit form */}
      {(canEditCore || canEditCaseDetails) && editing ? (
        <form className="task-form" onSubmit={onSaveCore} noValidate>
          {coreErr && (
            <div className="dash-alert dash-alert-error" role="alert">
              {coreErr}
            </div>
          )}
          {/* CORE INFO — client, opponent, type, leader, Drive link.
              Hidden for someone who may only set the case details (a
              manager without the wider edit permission), so the form
              never shows a field the server would refuse to save. */}
          {canEditCore && (
            <>
          {/* FOLDER TYPE — first; switching it re-shapes the form below. */}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-type">
              {lang === 'ar' ? 'نوع الملف' : 'Folder type'}
            </label>
            <select
              id="edit-type"
              className="dash-input"
              value={editFolderType}
              onChange={(e) => setEditFolderType(e.target.value as ClientFolderType)}
            >
              {folderTypes.length > 0 ? (
                folderTypes.map((ft) => (
                  <option key={ft.key} value={ft.key}>
                    {lang === 'ar' ? ft.labelAr : ft.labelEn}
                  </option>
                ))
              ) : (
                <>
                  <option value="case">{lang === 'ar' ? 'قضية' : 'Case'}</option>
                  <option value="contract">
                    {lang === 'ar' ? 'عقد' : 'Contract'}
                  </option>
                </>
              )}
            </select>
            {editIsContractForRender && (
              <p className="dash-hint" style={{ margin: '6px 0 0' }}>
                {lang === 'ar'
                  ? 'عقد: الموكّل فقط — سيتم مسح الخصم عند الحفظ.'
                  : 'Contract: client only — the opponent is cleared on save.'}
              </p>
            )}
          </div>
          {/* SECOND FOLDER TYPE — optional, and deliberately NOT part of the
              form's shape. Only the FIRST type decides whether there is an
              opponent; a folder that is both a case and a contract has to
              render as one of them, and letting the second type vote would
              make the visible fields depend on the order they were picked in.
              The type chosen above is excluded so it cannot be picked twice
              (the database refuses that too). */}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-type-2">
              {t.secondFolderType}
            </label>
            <select
              id="edit-type-2"
              className="dash-input"
              value={editFolderType2}
              onChange={(e) => setEditFolderType2(e.target.value)}
            >
              <option value="">{t.noSecondType}</option>
              {folderTypes
                .filter((ft) => ft.key !== editFolderType)
                .map((ft) => (
                  <option key={ft.key} value={ft.key}>
                    {lang === 'ar' ? ft.labelAr : ft.labelEn}
                  </option>
                ))}
            </select>
            <div className="dash-hint">{t.secondFolderTypeHint}</div>
          </div>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-client">
              {t.fileClient}
            </label>
            <select
              id="edit-client"
              className="dash-input"
              value={editClientContactId}
              onChange={(e) => setEditClientContactId(e.target.value)}
              disabled={contactsLoading || contacts.length === 0}
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
            {!contactsLoading && !contactsError && contacts.length === 0 && (
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
          {/* OPPONENT — a CASE only. */}
          {!editIsContractForRender && (
            <>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="edit-opponent-ar">
                  {lang === 'ar' ? 'الخصم (بالعربية)' : 'Opponent (Arabic)'}
                </label>
                <input
                  id="edit-opponent-ar"
                  className="dash-input"
                  dir="rtl"
                  value={editOpponentAr}
                  onChange={(e) => setEditOpponentAr(e.target.value)}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="edit-opponent-en">
                  {lang === 'ar' ? 'الخصم (بالإنجليزية)' : 'Opponent (English)'}
                </label>
                <input
                  id="edit-opponent-en"
                  className="dash-input"
                  dir="ltr"
                  value={editOpponentEn}
                  onChange={(e) => setEditOpponentEn(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="edit-lawyer">
              {t.fileManagingLawyer}
            </label>
            <select
              id="edit-lawyer"
              className="dash-input"
              value={editFolderLeaderId}
              onChange={(e) => setEditFolderLeaderId(e.target.value)}
              disabled={membersLoading || folderLeaderMembers.length === 0}
              required
            >
              <option value="">
                {membersLoading
                  ? '…'
                  : lang === 'ar'
                  ? 'اختر عضوًا…'
                  : 'Select a member…'}
              </option>
              {folderLeaderMembers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
            {!membersLoading && !membersError && folderLeaderMembers.length === 0 && (
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
            <label className="dash-eyebrow" htmlFor="edit-drive">
              {t.fileDriveLink}{' '}
              <span className="dash-hint" style={{ display: 'inline' }}>
                {t.optionalTag}
              </span>
            </label>
            <input
              id="edit-drive"
              className="dash-input"
              value={editDrive}
              onChange={(e) => setEditDrive(e.target.value)}
              dir="ltr"
              placeholder="https://drive.google.com/…"
            />
          </div>
            </>
          )}
          {file.folderTypeLayout !== 'contract' && (
            <>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="edit-case-number">
                  {t.fileCaseNumber}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <input
                  id="edit-case-number"
                  className="dash-input"
                  value={editCaseNumber}
                  onChange={(e) => setEditCaseNumber(e.target.value)}
                  placeholder={t.fileCaseNumberPlaceholder}
                  maxLength={120}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="edit-court">
                  {t.fileCourt}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <input
                  id="edit-court"
                  className="dash-input"
                  value={editCourt}
                  onChange={(e) => setEditCourt(e.target.value)}
                  placeholder={t.fileCourtPlaceholder}
                  maxLength={120}
                />
              </div>
              <div className="dash-field">
                <label className="dash-eyebrow" htmlFor="edit-case-level">
                  {t.fileCaseLevel}{' '}
                  <span className="dash-hint" style={{ display: 'inline' }}>
                    {t.optionalTag}
                  </span>
                </label>
                <select
                  id="edit-case-level"
                  className="dash-input"
                  value={editCaseLevel}
                  onChange={(e) => setEditCaseLevel(e.target.value)}
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
                  {editCaseLevel && !isKnownCaseLevel(editCaseLevel) ? (
                    <option value={editCaseLevel}>{editCaseLevel}</option>
                  ) : null}
                </select>
              </div>
            </>
          )}
          {isAdmin && (
            <div className="dash-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={editIsGeneral}
                  onChange={(e) => setEditIsGeneral(e.target.checked)}
                />
                <span style={{ fontSize: 13.5 }}>{t.generalFolder}</span>
              </label>
              <div className="dash-hint">{t.generalFolderHint}</div>
            </div>
          )}
          {canPin && (
            <div className="dash-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={editIsPinned}
                  onChange={(e) => setEditIsPinned(e.target.checked)}
                />
                <span style={{ fontSize: 13.5 }}>{t.pinnedFolder}</span>
              </label>
              <div className="dash-hint">{t.pinnedFolderHint}</div>
            </div>
          )}
          <div className="dash-modal-actions">
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={() => {
                setEditing(false);
                setCoreErr(null);
              }}
              disabled={savingCore}
            >
              {t.cancel}
            </button>
            <button type="submit" className="dash-btn-gold" disabled={savingCore}>
              {savingCore
                ? lang === 'ar'
                  ? 'جارٍ الحفظ…'
                  : 'Saving…'
                : lang === 'ar'
                ? 'حفظ'
                : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        /* The folder's facts sit on the LEFT in Arabic and the RIGHT in English.
           That is one rule, not two: `end` is the right in LTR and the left in
           RTL, so it needs no language conditional — and a conditional here is
           actively wrong, because `start` in Arabic resolves to the right. */
        <div className="file-detail-grid fd-facts">
          <div>
            <div className="dash-eyebrow">
              {lang === 'ar' ? 'نوع الملف' : 'Folder type'}
            </div>
            <div className="file-detail-value">
              {(() => {
                const ft = folderTypes.find((x) => x.key === file.folderType);
                if (ft) return lang === 'ar' ? ft.labelAr : ft.labelEn;
                // Fallback for the instant before folderTypes loads.
                return file.folderTypeLayout === 'contract'
                  ? lang === 'ar'
                    ? 'عقد'
                    : 'Contract'
                  : lang === 'ar'
                  ? 'قضية'
                  : 'Case';
              })()}
            </div>
          </div>
          <div>
            <div className="dash-eyebrow">{t.fileClient}</div>
            <div className="file-detail-value" dir="auto">
              {fileClientName(file, lang)}
            </div>
          </div>
          {/* A contract-layout type has no opponent — the row is omitted. */}
          {file.folderTypeLayout !== 'contract' && (
            <div>
              <div className="dash-eyebrow">{t.fileOpponent}</div>
              <div className="file-detail-value" dir="auto">
                {fileOpponentName(file, lang)}
              </div>
            </div>
          )}
          <div>
            <div className="dash-eyebrow">{t.fileManagingLawyer}</div>
            <div className="file-detail-value" dir="auto">
              {fileFolderLeaderName(file, lang)}
            </div>
          </div>
          {/* Case identity. Shown only for a case-layout folder, and only for
              the values that were actually filled in — an empty row labelled
              "Court" tells the reader nothing. */}
          {file.isGeneral && (
            <div>
              <div className="dash-eyebrow">{t.generalFolder}</div>
              <div className="file-detail-value">{t.generalFolderBadge}</div>
            </div>
          )}
          {file.isPinned && (
            <div>
              <div className="dash-eyebrow">{t.pinnedFolder}</div>
              <div className="file-detail-value">{t.pinnedFolderBadge}</div>
            </div>
          )}
          {/* The second type, resolved to its LABEL — the stored value is a key
              ('service-agreement'), which is not what anyone calls it. Falls
              back to the key itself if the types have not loaded, rather than
              rendering an empty row. */}
          {file.folderType2 && (
            <div>
              <div className="dash-eyebrow">{t.secondFolderType}</div>
              <div className="file-detail-value" dir="auto">
                {(() => {
                  const ft = folderTypes.find((x) => x.key === file.folderType2);
                  if (!ft) return file.folderType2;
                  return lang === 'ar' ? ft.labelAr : ft.labelEn;
                })()}
              </div>
            </div>
          )}
          {file.folderTypeLayout !== 'contract' && file.caseNumber && (
            <div>
              <div className="dash-eyebrow">{t.fileCaseNumber}</div>
              <div className="file-detail-value" dir="auto">{file.caseNumber}</div>
            </div>
          )}
          {file.folderTypeLayout !== 'contract' && file.court && (
            <div>
              <div className="dash-eyebrow">{t.fileCourt}</div>
              <div className="file-detail-value" dir="auto">{file.court}</div>
            </div>
          )}
          {file.folderTypeLayout !== 'contract' && file.caseLevel && (
            <div>
              <div className="dash-eyebrow">{t.fileCaseLevel}</div>
              <div className="file-detail-value" dir="auto">
                {caseLevelLabel(file.caseLevel, lang)}
              </div>
            </div>
          )}
          <div>
            <div className="dash-eyebrow">{t.fileCreated}</div>
            <div className="file-detail-value" dir="auto">
              {formatDate(file.createdAt, lang)}
            </div>
          </div>
          <div>
            <div className="dash-eyebrow">{t.fileSection}</div>
            <div className="file-detail-value">
              <span
                className="files-chip"
                style={{
                  background: `${sectionColor}22`,
                  color: '#5b564e',
                  border: `1px solid ${sectionColor}`,
                }}
              >
                {sectionLabel(file.section)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Access */}
      <div className="file-detail-block">
        <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
          {t.accessSectionTitle}
        </div>

        {accessMsg && (
          <div
            className="dash-alert dash-alert-ok"
            role="status"
            style={{ marginBottom: 10 }}
          >
            {accessMsg}
          </div>
        )}
        {accessErr && (
          <div
            className="dash-alert dash-alert-error"
            role="alert"
            style={{ marginBottom: 10 }}
          >
            {accessErr}
          </div>
        )}

        {accessLoading ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            …
          </p>
        ) : accessRefused ? (
          <p className="dash-hint" style={{ margin: 0 }}>
            {lang === 'ar'
              ? 'قائمة الوصول غير متاحة لك.'
              : 'The access list is not available to you.'}
          </p>
        ) : accessLoadError ? (
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadAccess}
          </div>
        ) : (
          <>
            {/* Current members */}
            {members.length === 0 ? (
              <p className="dash-hint" style={{ margin: '0 0 4px' }}>
                {t.noEmployeesOnFile}
              </p>
            ) : (
              <ul className="access-list">
                {members.map((m) => (
                  <li key={m.userId} className="access-pill">
                    <span className="access-avatar" aria-hidden="true">
                      {initialOf(personName(m))}
                    </span>
                    <span className="access-pill-name">{personName(m)}</span>
                    {canManageAccess && (
                      <button
                        type="button"
                        className="access-remove"
                        onClick={() => onRemove(m.userId)}
                        disabled={removingId === m.userId}
                      >
                        {removingId === m.userId ? t.removing : t.remove}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Forced-reassignment picker (member has open tasks) */}
            {reassignFor && (
              <div className="task-reassign-panel">
                <p className="dash-hint" style={{ margin: '0 0 8px' }}>
                  {t.reassignPrompt}
                </p>
                <div className="access-add-row">
                  <select
                    className="dash-input"
                    aria-label={t.reassignToLabel}
                    value={reassignTo}
                    onChange={(e) => setReassignTo(e.target.value)}
                  >
                    <option value="">{t.reassignToLabel}…</option>
                    {members
                      .filter((m) => m.userId !== reassignFor)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {personName(m)}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="dash-btn-gold"
                    disabled={!reassignTo || removingId === reassignFor}
                    onClick={() => onRemove(reassignFor, reassignTo)}
                  >
                    {removingId === reassignFor ? t.removing : t.reassignAndRemove}
                  </button>
                  <button
                    type="button"
                    className="dash-btn-ghost"
                    disabled={removingId === reassignFor}
                    onClick={() => {
                      setReassignFor(null);
                      setReassignTo('');
                      setAccessErr(null);
                    }}
                  >
                    {t.cancel}
                  </button>
                </div>
              </div>
            )}

            {/* Pending requests */}
            {pending.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="dash-eyebrow" style={{ marginBottom: 6 }}>
                  {t.accessPendingLabel}
                </div>
                <ul className="access-list">
                  {pending.map((p) => (
                    <li key={p.id} className="access-pill is-pending">
                      <span className="access-avatar is-muted" aria-hidden="true">
                        {initialOf(personName(p.employee))}
                      </span>
                      <span className="access-pill-name">
                        {personName(p.employee)}
                      </span>
                      <span className="access-pending-chip">{t.pendingChip}</span>
                      <span className="access-pill-by">
                        {t.requestedByShort} {personName(p.requestedBy)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Request-to-add control. Picking an employee STAGES them as a chip
                rather than sending immediately, so several people can be picked
                and requested in one click. */}
            {canManageAccess && (
              <div style={{ marginTop: 14 }}>
                {assignable.length === 0 && pickedEmployees.length === 0 ? (
                  <p className="dash-hint" style={{ margin: 0 }}>
                    {t.noAssignableEmployees}
                  </p>
                ) : (
                  <>
                    {pickedEmployees.length > 0 && (
                      <ul className="access-list" style={{ marginBottom: 8 }}>
                        {pickedEmployees.map((userId) => {
                          const person =
                            assignable.find((e) => e.userId === userId) ??
                            members.find((e) => e.userId === userId);
                          return (
                            <li key={userId} className="access-pill">
                              <span className="access-avatar" aria-hidden="true">
                                {person ? initialOf(personName(person)) : '?'}
                              </span>
                              <span className="access-pill-name">
                                {person ? personName(person) : userId}
                              </span>
                              <button
                                type="button"
                                className="access-remove"
                                disabled={requesting}
                                onClick={() =>
                                  setPickedEmployees((prev) =>
                                    prev.filter((id) => id !== userId)
                                  )
                                }
                              >
                                {t.remove}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="access-add-row">
                      <select
                        className="dash-input"
                        aria-label={t.requestAddEmployee}
                        value=""
                        disabled={
                          assignable.filter(
                            (e) => !pickedEmployees.includes(e.userId)
                          ).length === 0
                        }
                        onChange={(e) => {
                          const userId = e.target.value;
                          if (!userId) return;
                          setPickedEmployees((prev) =>
                            prev.includes(userId) ? prev : [...prev, userId]
                          );
                        }}
                      >
                        <option value="">{t.selectEmployeePlaceholder}</option>
                        {assignable
                          .filter((e) => !pickedEmployees.includes(e.userId))
                          .map((e) => (
                            <option key={e.userId} value={e.userId}>
                              {personName(e)}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="dash-btn-gold"
                        onClick={onRequestAdd}
                        disabled={requesting || pickedEmployees.length === 0}
                      >
                        {requesting
                          ? t.sending
                          : t.requestAddEmployeeCount.replace(
                              '{count}',
                              String(pickedEmployees.length)
                            )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Color step bar — computed by the Phase-5 color engine. Segments up to
          the current step are filled; the rest are dimmed. */}
      <div className="file-detail-block">
        <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
          {t.colorStatus}
        </div>
        <div className="file-colorbar" aria-hidden="true">
          {ladderKeys.map((key, i) => {
            const reached = i <= stepIndex;
            const isCurrent = i === stepIndex;
            return (
              <span
                key={key}
                className={`file-colorstep${isCurrent ? ' is-current' : ''}`}
                style={{
                  background: FILE_STATUS_PALETTE[key],
                  opacity: reached ? 1 : 0.22,
                }}
              />
            );
          })}
        </div>
        <div className="dash-hint" style={{ marginTop: 6 }}>
          <strong style={{ color: '#5b564e' }}>{t.colorCurrentLabel}:</strong>{' '}
          {colorName(file.color.colorKey, t)}
          {file.color.alertLevel === 'critical' && (
            <span className="file-alert-chip" style={{ marginInlineStart: 8 }}>
              {t.alertBadge}
            </span>
          )}
        </div>
        <div className="dash-hint" style={{ marginTop: 4 }}>
          {t.colorStatusHint}
        </div>
      </div>

      {/* Move control */}
      {canMove && (
        <div className="file-detail-block">
          <div className="dash-eyebrow" style={{ marginBottom: 8 }}>
            {t.moveFile}
          </div>
          <div className="file-move-row">
            <select
              className="dash-input"
              aria-label={t.moveTo}
              value={target}
              onChange={(e) => setTarget(e.target.value as FileSection)}
            >
              {FILE_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {sectionLabel(s)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dash-btn-gold"
              onClick={onMove}
              disabled={moving || target === file.section}
            >
              {moving ? t.moving : t.moveFile}
            </button>
          </div>
        </div>
      )}

      {/* Danger zone — gated on can_delete_file. Kept at the very bottom,
          visually separated so it is never hit by accident; the actual delete is
          behind a type-to-confirm guard. */}
      {canDeleteFile && (
        <div className="file-detail-block file-danger-zone">
          <div
            className="dash-eyebrow"
            style={{ marginBottom: 8, color: '#9a3b2f' }}
          >
            {lang === 'ar' ? 'منطقة الخطر' : 'Danger zone'}
          </div>
          <div className="file-danger-row">
            <p className="dash-hint" style={{ margin: 0 }}>
              {lang === 'ar'
                ? 'حذف هذا المجلد وكل ما يتبعه نهائيًا.'
                : 'Permanently delete this folder and everything it owns.'}
            </p>
            <button
              type="button"
              className="dash-btn-ghost file-danger-btn"
              onClick={() => setShowDelete(true)}
            >
              {lang === 'ar' ? 'حذف المجلد' : 'Delete folder'}
            </button>
          </div>
        </div>
      )}

      {canDeleteFile && showDelete && (
        <DeleteFolderConfirm
          file={file}
          lang={lang}
          onCancel={() => setShowDelete(false)}
          onDeleted={(id) => {
            setShowDelete(false);
            onDeleted(id);
          }}
        />
      )}
    </>
  );
}
