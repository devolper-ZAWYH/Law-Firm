import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import {
  isFileSection,
  SECTIONS_HIDDEN_FROM_EMPLOYEES,
  type FileSection,
} from './fileColors';
import { openTasksForColorByFile, type FileColorTask } from './tasks';
import {
  fileColor,
  isClosedSection,
  type ColorCompanySettings,
  type FileColor,
} from './colorEngine';
import {
  folderTypeLayoutsByKey,
  type FolderTypeLayout,
} from './folderTypes';

/**
 * Files data-access layer (Phase 2).
 *
 * Pure data access over the `files` table using the service-role client. It
 * performs NO authorization — every caller (the API routes) resolves the
 * platform user and re-checks the two-layer model BEFORE calling these, and
 * scopes every query to a single company (the hard isolation boundary).
 *
 * COLOR is not stored: it is DERIVED from the file's open/awaiting tasks by the
 * color engine (Phase 5), computed here on read. The company's settings
 * (working_days, days_per_color_step) are loaded once per request and each
 * file's color is evaluated at a single `now`, so the client just renders.
 */

export type { FileSection };

/**
 * What KIND of folder this is — a key into the `folder_types` table, which
 * decides which fields it carries and how its title renders via its LAYOUT:
 *   • 'case'     → CLIENT + OPPONENT (title = client / vs / opponent).
 *   • 'contract' → CLIENT ONLY (opponent forced to null; title = client).
 * Custom types (admin/manager-added) are additional keys that reuse one of
 * these two layouts. Legacy folders (and the DB default) are 'case'.
 */
export type FolderType = string;

/** Loose guard: a non-empty trimmed string. Real validity (does this key exist
 * in `folder_types`?) is checked by the caller against the DB — this only
 * rules out obviously-malformed input. */
export function isFolderType(v: unknown): v is FolderType {
  return typeof v === 'string' && v.trim().length > 0;
}

export interface PlatformFile {
  id: string;
  /** Legacy client text — the selected contact's display name, always written. */
  client: string;
  companyId: string;
  /** The folder type's key (e.g. 'case', 'contract', or a custom type). */
  folderType: FolderType;
  /** The RESOLVED layout for folderType — 'case' (+ opponent) or 'contract'
   * (client only). Custom types carry whichever layout they were given. */
  folderTypeLayout: FolderTypeLayout;
  opponent: string;
  /** Legacy folder-leader text — the selected member's display name, always written. */
  managingLawyer: string;
  driveLink: string | null;
  section: FileSection;
  createdBy: string;
  createdAt: string;
  /**
   * The CRM contact this folder's client points at, or null for a legacy folder
   * created before the link existed (or whose contact was later deleted).
   */
  clientContactId: string | null;
  /**
   * Resolved bilingual client name. English-preferred / Arabic-preferred views
   * of the linked contact, each already falling back to the other language,
   * then the legacy `client` text — so NEITHER is ever empty.
   */
  clientEn: string;
  clientAr: string;
  /** Raw stored bilingual opponent (either may be '' when only one is set). */
  opponentEn: string;
  opponentAr: string;
  /**
   * The company member this folder's leader points at, or null for a legacy
   * folder created before the link existed (or whose user was later deleted).
   */
  folderLeaderId: string | null;
  /**
   * Resolved bilingual folder-leader name. English-preferred / Arabic-preferred
   * views of the linked member, each already falling back to the other language,
   * then the legacy `managingLawyer` text — so NEITHER is ever empty.
   */
  folderLeaderEn: string;
  folderLeaderAr: string;
  /**
   * Case identity. Free text (see migration #32) and '' when unset, never null,
   * so every consumer can render them without a null check. `caseNumber` is
   * what the folder list shows in place of the internal id it used to print.
   */
  caseNumber: string;
  court: string;
  caseLevel: string;
  /**
   * The ONE company-wide folder every employee can see without an explicit
   * access grant (migration #32 enforces at most one per company).
   */
  isGeneral: boolean;
  /**
   * PINNED (migration #33): visible to every employee of the company without an
   * access grant, and sorted to the front of the list.
   *
   * The second such widening, alongside `isGeneral`, and deliberately so: the
   * general folder is capped at one per company by a database index, and a firm
   * regularly has several folders everyone needs at once (the office manual,
   * the current big matter). Unlike the general folder there is no limit on how
   * many may be pinned, which is exactly why only admins and managers may pin.
   */
  isPinned: boolean;
  /**
   * An OPTIONAL SECOND folder type key (migration #33), or null. A matter is
   * often two things at once — a contract that became a case — and one type
   * column forces it to be filed as only half of what it is.
   *
   * The FIRST type still decides the folder's LAYOUT; this one is a label the
   * folder also carries. Letting both drive layout would mean a folder whose
   * fields depended on the order its two types were picked in.
   */
  folderType2: string | null;
  /**
   * Count of UNFINISHED tasks (open + awaiting_approval) — drives the folder
   * badge. Live as of Phase 4.
   */
  openTaskCount: number;
  /** DERIVED status color (Phase 5): tint, step-bar position and alert level. */
  color: FileColor;
  /**
   * The company's color-ladder settings, echoed so the CLIENT can reuse the
   * shared color engine to show a per-task "time until next color" countdown
   * (working-time only). Not secret — same values that drive `color`.
   */
  workingDays: number[];
  daysPerColorStep: number;
}

// Raw row shape from PostgREST (untyped JSON; cast defensively).
interface FileRow {
  id: string;
  company_id: string;
  client: string;
  opponent: string;
  managing_lawyer: string;
  drive_link: string | null;
  section: string;
  created_by: string;
  created_at: string;
  client_contact_id: string | null;
  opponent_en: string | null;
  opponent_ar: string | null;
  folder_leader_id: string | null;
  /** Absent (undefined) until schema_files_type.sql has been applied. */
  folder_type?: string | null;
  /** Absent (undefined) until migration #32 has been applied. */
  case_number?: string | null;
  court?: string | null;
  case_level?: string | null;
  is_general?: boolean | null;
  /** Absent (undefined) until migration #33 has been applied. */
  is_pinned?: boolean | null;
  folder_type_2?: string | null;
}

/** Column list BEFORE schema_files_type.sql — the deploy-safety fallback. */
const FILE_COLUMNS_LEGACY =
  'id, company_id, client, opponent, managing_lawyer, drive_link, section, created_by, created_at, client_contact_id, opponent_en, opponent_ar, folder_leader_id';

/** The full column list, including folder_type. */
const FILE_COLUMNS = `${FILE_COLUMNS_LEGACY}, folder_type`;

/** The case-detail columns, added by migration #32. */
const FILE_CASE_COLUMNS = 'case_number, court, case_level, is_general';

/** Pinning + the second folder type, added by migration #33. */
const FILE_PIN_COLUMNS = 'is_pinned, folder_type_2';

/**
 * Build the select list for the capabilities this database is known to have.
 * THREE INDEPENDENT feature flags, because the column groups arrived in
 * different migrations and a database can be missing any combination of them.
 */
function fileColumns(
  withType: boolean,
  withCase: boolean,
  withPin: boolean
): string {
  return [
    FILE_COLUMNS_LEGACY,
    withType ? 'folder_type' : null,
    withCase ? FILE_CASE_COLUMNS : null,
    withPin ? FILE_PIN_COLUMNS : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * DEPLOY SAFETY. The app may be live for a few minutes BEFORE the operator runs
 * schema_files_type.sql. Until then `files.folder_type` does not exist and every
 * select/insert naming it fails with PostgREST 42703 (undefined column) — which
 * would 500 the whole Files view. So the first such failure LATCHES this flag
 * off and the query is retried against the legacy column set; rows then map with
 * folderType = 'case' (exactly the pre-migration behaviour). After the migration
 * the first request of a fresh process succeeds and the flag stays on.
 */
let filesHasFolderType = true;
/** Does this database have migration #32's case-detail columns? See runFileQuery. */
let filesHasCaseDetails = true;
/** Does this database have migration #33's pinning columns? See runFileQuery. */
let filesHasPinning = true;

/**
 * The only part of a PostgREST response this helper needs. `data` is `unknown`
 * ON PURPOSE: supabase-js can only infer a row shape from a LITERAL select
 * string, and ours is a runtime variable (the with/without-folder_type switch),
 * so it degrades the builder's data type to `GenericStringError[]`. Accepting
 * `unknown` here lets any of those builders satisfy the callback type without
 * each call site needing its own cast.
 */
interface Postgrestish {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/**
 * Run a files query built from the current column set, retrying ONCE without
 * folder_type if the column does not exist yet. `withType` also tells writers
 * whether they may include folder_type in their payload.
 *
 * `T` is the row shape the CALLER knows the query returns (FileRow / FileRow[]).
 * The single `as T | null` below is the ONE seam where it is reapplied, undoing
 * the dynamic-select erasure described on Postgrestish. Everything downstream
 * still goes through mapRow, so the mapping stays type-checked.
 */
async function runFileQuery<T>(
  run: (
    columns: string,
    withType: boolean,
    withCase: boolean,
    withPin: boolean
  ) => PromiseLike<Postgrestish>
): Promise<T | null> {
  const attempt = (withType: boolean, withCase: boolean, withPin: boolean) =>
    run(fileColumns(withType, withCase, withPin), withType, withCase, withPin);

  let res = await attempt(
    filesHasFolderType,
    filesHasCaseDetails,
    filesHasPinning
  );

  // DEPLOY SAFETY. New code reaches production BEFORE its migration runs, so a
  // column this build knows about may not exist yet. Retry NEWEST GROUP FIRST
  // — pinning (#33), then case details (#32), then folder_type — because a
  // database missing the newest is the common case during a deploy, and
  // dropping an older group first would discard columns that are actually
  // there. The flags latch, so the cost is one wasted round trip per process,
  // not per request. Without this the folder list 500s for the whole deploy
  // window.
  if (res.error?.code === '42703' && filesHasPinning) {
    filesHasPinning = false;
    res = await attempt(filesHasFolderType, filesHasCaseDetails, false);
  }
  if (res.error?.code === '42703' && filesHasCaseDetails) {
    filesHasCaseDetails = false;
    res = await attempt(filesHasFolderType, false, filesHasPinning);
  }
  if (res.error?.code === '42703' && filesHasFolderType) {
    filesHasFolderType = false;
    res = await attempt(false, filesHasCaseDetails, filesHasPinning);
  }
  if (res.error) throw new Error(res.error.message);
  // Cast FROM `unknown`, which is always permitted — no `??` first, because
  // `unknown ?? null` widens to `{} | null` and casting THAT to an unconstrained
  // generic is what TS rejects. PostgREST returns null (never undefined) here.
  return res.data as T | null;
}

/** Minimal contact name shape used to resolve a folder's bilingual client. */
interface ContactNameRow {
  id: string;
  name: string | null;
  name_en: string | null;
  name_ar: string | null;
}

/**
 * Resolve contact names for a set of ids (the folders' client_contact_id) in a
 * single query. Nulls/blanks are dropped; returns a Map keyed by contact id.
 */
async function contactNamesByIds(
  ids: Array<string | null>
): Promise<Map<string, ContactNameRow>> {
  const map = new Map<string, ContactNameRow>();
  const unique = Array.from(
    new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))
  );
  if (unique.length === 0) return map;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('contacts')
    .select('id, name, name_en, name_ar')
    .in('id', unique);
  if (res.error) throw new Error(res.error.message);
  for (const r of (res.data as ContactNameRow[] | null) ?? []) {
    map.set(r.id, r);
  }
  return map;
}

/** A contact brief for company-isolation checks + legacy display-name writes. */
export interface ContactBrief {
  id: string;
  companyId: string;
  nameEn: string | null;
  nameAr: string | null;
  name: string | null;
}

/** Load one contact (id + company + names), or null if it does not exist. */
export async function getContactBrief(id: string): Promise<ContactBrief | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('contacts')
    .select('id, company_id, name, name_en, name_ar')
    .eq('id', id)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as {
    id: string;
    company_id: string;
    name: string | null;
    name_en: string | null;
    name_ar: string | null;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    name: row.name,
  };
}

/** The legacy display name written to files.client (Arabic-default platform). */
export function contactDisplayName(c: {
  nameEn: string | null;
  nameAr: string | null;
  name: string | null;
}): string {
  return c.nameAr || c.nameEn || c.name || '';
}

/** Minimal member name shape used to resolve a folder's bilingual leader. */
interface MemberNameRow {
  id: string;
  username: string | null;
  email: string | null;
  full_name_en: string | null;
  full_name_ar: string | null;
}

/**
 * Resolve member names for a set of ids (the folders' folder_leader_id) in a
 * single query. Nulls/blanks are dropped; returns a Map keyed by user id.
 */
async function memberNamesByIds(
  ids: Array<string | null>
): Promise<Map<string, MemberNameRow>> {
  const map = new Map<string, MemberNameRow>();
  const unique = Array.from(
    new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))
  );
  if (unique.length === 0) return map;
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('app_users')
    .select('id, username, email, full_name_en, full_name_ar')
    .in('id', unique);
  if (res.error) throw new Error(res.error.message);
  for (const r of (res.data as MemberNameRow[] | null) ?? []) {
    map.set(r.id, r);
  }
  return map;
}

/** A member brief for company-membership checks + legacy display-name writes. */
export interface MemberBrief {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
  email: string | null;
  username: string | null;
}

/**
 * Load one company member (the app_user linked by a membership in `companyId`),
 * or null if that user has NO membership in the company. Used to validate a
 * chosen folder leader and to write the legacy `managing_lawyer` display name.
 */
export async function getCompanyMemberBrief(
  userId: string,
  companyId: string
): Promise<MemberBrief | null> {
  const supabase = getSupabaseAdmin();
  const memRes = await supabase
    .from('memberships')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memRes.error) throw new Error(memRes.error.message);
  if (!memRes.data) return null;

  const userRes = await supabase
    .from('app_users')
    .select('id, username, email, full_name_en, full_name_ar')
    .eq('id', userId)
    .maybeSingle();
  if (userRes.error) throw new Error(userRes.error.message);
  const row = userRes.data as MemberNameRow | null;
  if (!row) return null;
  return {
    id: row.id,
    nameEn: row.full_name_en,
    nameAr: row.full_name_ar,
    email: row.email,
    username: row.username,
  };
}

/** The legacy display name written to files.managing_lawyer (Arabic-default). */
export function memberDisplayName(m: {
  nameEn: string | null;
  nameAr: string | null;
  email: string | null;
  username: string | null;
}): string {
  return m.nameAr || m.nameEn || m.email || m.username || '';
}

const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];
const DEFAULT_DAYS_PER_STEP = 3;

/**
 * A company's color-engine settings (working_days + days_per_color_step),
 * loaded ONCE per request. Falls back to the schema defaults if the row is
 * missing or the columns are null.
 */
async function getCompanyColorSettings(
  companyId: string
): Promise<ColorCompanySettings> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('companies')
    .select('working_days, days_per_color_step')
    .eq('id', companyId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as {
    working_days: number[] | null;
    days_per_color_step: number | null;
  } | null;
  const days = row?.working_days;
  const perStep = row?.days_per_color_step;
  return {
    workingDays:
      Array.isArray(days) && days.length > 0 ? days : DEFAULT_WORKING_DAYS,
    daysPerColorStep:
      typeof perStep === 'number' && perStep > 0
        ? perStep
        : DEFAULT_DAYS_PER_STEP,
  };
}

/**
 * Normalize a raw DB row into a typed PlatformFile (guards the section enum)
 * and attach the DERIVED color for the file's unfinished tasks. `now` is passed
 * in so every file in a list is evaluated at one instant.
 */
function mapRow(
  row: FileRow,
  tasks: FileColorTask[],
  settings: ColorCompanySettings,
  now: Date,
  contactMap: Map<string, ContactNameRow>,
  memberMap: Map<string, MemberNameRow>,
  layoutByType: Map<string, FolderTypeLayout>
): PlatformFile {
  const section: FileSection = isFileSection(row.section)
    ? row.section
    : 'potential';
  const color = fileColor({ section }, tasks, settings, now);
  // '' rather than null for the case details: they are display strings, and a
  // null would force every call site to guard before rendering.
  const caseNumber = (row.case_number ?? '').trim();
  const court = (row.court ?? '').trim();
  const caseLevel = (row.case_level ?? '').trim();

  // A missing column (pre-migration) or any unknown value reads as 'case', so a
  // legacy folder keeps its client-vs-opponent behaviour.
  const folderType: FolderType = isFolderType(row.folder_type)
    ? row.folder_type
    : 'case';
  const folderTypeLayout: FolderTypeLayout =
    layoutByType.get(folderType) ?? 'case';

  // Resolve the bilingual client from the linked CRM contact; a legacy folder
  // (no link, or a deleted contact) falls back to the stored `client` text for
  // BOTH languages so neither field is ever empty.
  const contact = row.client_contact_id
    ? contactMap.get(row.client_contact_id)
    : undefined;
  const clientEn =
    contact?.name_en || contact?.name_ar || contact?.name || row.client;
  const clientAr =
    contact?.name_ar || contact?.name_en || contact?.name || row.client;

  // Resolve the bilingual folder leader from the linked member; a legacy folder
  // (no link, or a deleted user) falls back to the stored `managing_lawyer` text
  // for BOTH languages so neither field is ever empty.
  const leader = row.folder_leader_id
    ? memberMap.get(row.folder_leader_id)
    : undefined;
  const folderLeaderEn =
    leader?.full_name_en ||
    leader?.full_name_ar ||
    leader?.email ||
    leader?.username ||
    row.managing_lawyer;
  const folderLeaderAr =
    leader?.full_name_ar ||
    leader?.full_name_en ||
    leader?.email ||
    leader?.username ||
    row.managing_lawyer;

  const isContract = folderTypeLayout === 'contract';

  return {
    id: row.id,
    companyId: row.company_id,
    folderType,
    folderTypeLayout,
    client: row.client,
    // A contract-layout folder never exposes an opponent, even if a stale
    // value is still stored — the title must not render a "vs" line for it.
    opponent: isContract ? '' : row.opponent,
    managingLawyer: row.managing_lawyer,
    driveLink: row.drive_link,
    section,
    createdBy: row.created_by,
    createdAt: row.created_at,
    clientContactId: row.client_contact_id ?? null,
    clientEn,
    clientAr,
    opponentEn: isContract ? '' : row.opponent_en ?? '',
    opponentAr: isContract ? '' : row.opponent_ar ?? '',
    folderLeaderId: row.folder_leader_id ?? null,
    folderLeaderEn,
    folderLeaderAr,
    caseNumber,
    court,
    caseLevel,
    isGeneral: row.is_general === true,
    isPinned: row.is_pinned === true,
    folderType2: row.folder_type_2 ?? null,
    // A CLOSED folder (expired / attrition) has no work in progress: its tasks
    // are kept for the record but stop counting, so the "open tasks" badge must
    // not keep advertising them. Fixing it here rather than per-view means the
    // grid, list, kanban and sidebar cannot disagree — the grid was still
    // showing a number after the countdown had already stopped.
    openTaskCount: isClosedSection(section) ? 0 : tasks.length,
    color,
    workingDays: settings.workingDays,
    daysPerColorStep: settings.daysPerColorStep,
  };
}

/**
 * The set of tasks a folder's color is derived from. The color is still
 * DERIVED, never stored, and every live caller now asks for `aggregate: true`
 * — EVERY employee's open tasks in the folder (the worst-case color) — so a
 * given folder paints the SAME color for every viewer who can see it (admin,
 * manager, or an employee), never a personalized subset. `aggregate: false`
 * is kept for completeness (and omitting the viewer still defaults to
 * aggregate) but nothing in the app currently opts into it.
 */
export interface FileColorViewer {
  userId: string;
  aggregate: boolean;
}

/** All files in ONE company, newest first. Caller enforces company isolation. */
export async function listFilesForCompany(
  companyId: string,
  viewer?: FileColorViewer
): Promise<PlatformFile[]> {
  const supabase = getSupabaseAdmin();
  const rows =
    (await runFileQuery<FileRow[]>((columns, _withType, _withCase, withPin) => {
      const q = supabase
        .from('files')
        .select(columns)
        .eq('company_id', companyId);
      // Pinned first, then newest — the same order every other folder reader
      // uses, so a pinned folder is at the top wherever it is listed.
      return (withPin ? q.order('is_pinned', { ascending: false }) : q).order(
        'created_at',
        { ascending: false }
      );
    })) ?? [];
  // Employee viewer → restrict the color tasks to their own; else aggregate.
  const assigneeFilter = viewer && !viewer.aggregate ? viewer.userId : undefined;
  const [settings, tasksByFile, contactMap, memberMap, layoutByType] =
    await Promise.all([
      getCompanyColorSettings(companyId),
      openTasksForColorByFile(rows.map((r) => r.id), assigneeFilter),
      contactNamesByIds(rows.map((r) => r.client_contact_id)),
      memberNamesByIds(rows.map((r) => r.folder_leader_id)),
      folderTypeLayoutsByKey(),
    ]);
  const now = new Date();
  return rows.map((r) =>
    mapRow(
      r,
      tasksByFile.get(r.id) ?? [],
      settings,
      now,
      contactMap,
      memberMap,
      layoutByType
    )
  );
}

/**
 * The files in ONE company that BELONG to a given employee — i.e. files where
 * the employee EITHER currently holds an ACTIVE access grant (a file_access row)
 * OR is the assignee of a task. This is the exact "an employee only sees files
 * they're connected to" rule; a folder the employee has no relationship to is
 * never returned.
 *
 * Company isolation is enforced HERE: the candidate ids (from grants + tasks,
 * which are not themselves company-scoped) are intersected with the company via
 * the final `.eq('company_id', companyId)`, so a grant or task pointing at
 * another company's file is dropped. The caller (route) has already verified the
 * user holds a role in `companyId`.
 *
 * Color is the SAME for every viewer — derived from EVERY employee's open tasks
 * on the folder (aggregate), exactly like the admin/manager Folders view, so the
 * same folder never shows a different color depending on who is looking at it.
 * openTaskCount stays PER-VIEWER (only this employee's own unfinished tasks) —
 * that badge is deliberately "how much is on MY plate", not the color.
 *
 * The Drive link is ACCESS-GATED: it is kept ONLY for files the employee has an
 * actual access grant to, and NULLED for task-only files (an approved task can
 * outlive a removed grant) — so the link never leaks to someone without a grant,
 * exactly like the tasks/mine gate.
 */
export async function listFilesForEmployee(
  companyId: string,
  userId: string,
  /**
   * Sections this employee may see WHOLESALE — every folder in them, grant or
   * not (the 'files.viewAll.<section>' capabilities). Empty is the normal case
   * and means "only what is theirs".
   *
   * Passed in rather than read here so the capability lookup stays in the
   * route, where every other authorization decision is made and can be seen
   * next to the ones around it.
   */
  visibleSections: readonly FileSection[] = []
): Promise<PlatformFile[]> {
  const supabase = getSupabaseAdmin();

  // (1) Files the employee currently has an ACTIVE access grant to.
  const accRes = await supabase
    .from('file_access')
    .select('file_id')
    .eq('user_id', userId);
  if (accRes.error) throw new Error(accRes.error.message);
  const grantedIds = new Set(
    ((accRes.data as { file_id: string }[] | null) ?? []).map((r) => r.file_id)
  );

  // (2) Files where the employee is the assignee of a task. DEPLOY SAFETY: if
  // the tasks table isn't migrated yet (42P01) degrade to grants only rather
  // than 500-ing the whole My Files view.
  const taskFileIds = new Set<string>();
  const taskRes = await supabase
    .from('tasks')
    .select('file_id')
    .eq('assignee_id', userId);
  if (taskRes.error) {
    if ((taskRes.error as { code?: string }).code !== '42P01') {
      throw new Error(taskRes.error.message);
    }
  } else {
    for (const r of (taskRes.data as { file_id: string }[] | null) ?? []) {
      taskFileIds.add(r.file_id);
    }
  }

  const candidateIds = Array.from(new Set([...grantedIds, ...taskFileIds]));

  // (3) Restrict to the ACTIVE company — the hard isolation boundary — and
  // ALSO admit that company's GENERAL folder, which every employee can see
  // without a grant. It is still company-scoped: `is_general` widens who may
  // see a folder, never which company's folders are considered.
  //
  // Expressed as one `or` rather than a second query so the company filter
  // applies to both halves and cannot be forgotten on the general branch.
  const generalFilter = 'is_general.eq.true';
  // PINNED folders are the second grant-free widening (migration #33): a folder
  // an admin or manager has pinned is visible to every employee of the company,
  // exactly as the general folder is, and for the same reason — some folders
  // are everybody's. Still company-scoped: this widens WHO may see a folder,
  // never WHICH company's folders are considered.
  const pinnedFilter = 'is_pinned.eq.true';
  // WHOLESALE SECTIONS — the third widening, and the only one an admin hands
  // out per employee. "See every Expired folder" admits that column entire,
  // and says nothing about the other three.
  const sectionFilter =
    visibleSections.length > 0
      ? `section.in.(${visibleSections.join(',')})`
      : null;
  const idFilter =
    candidateIds.length > 0 ? `id.in.(${candidateIds.join(',')})` : null;

  const rows =
    (await runFileQuery<FileRow[]>((columns, _withType, withCase, withPin) => {
      let q = supabase.from('files').select(columns).eq('company_id', companyId);
      // Each clause is included only when its column exists — an `or` naming a
      // missing column fails the whole query rather than the one branch.
      const clauses = [
        idFilter,
        withCase ? generalFilter : null,
        withPin ? pinnedFilter : null,
        sectionFilter,
      ].filter(Boolean) as string[];
      if (clauses.length > 1) {
        q = q.or(clauses.join(','));
      } else if (clauses.length === 1) {
        // A single clause is expressed directly: `or` with one member is the
        // same thing, but `in` keeps the common (grants-only) path plain.
        q = idFilter && clauses[0] === idFilter ? q.in('id', candidateIds) : q.or(clauses[0]);
      } else {
        // Nothing to match, and neither widening is available.
        q = q.in('id', ['00000000-0000-0000-0000-000000000000']);
      }
      // TERMINAL SECTIONS ARE NOT AN EMPLOYEE'S TO SEE — Expired (closed) and
      // Attrition (client lost). This sits OUTSIDE the `or` above, so it is an
      // AND over whatever matched: a folder reaches an employee here by grant,
      // by task assignment, by being general, by being pinned or by a wholesale
      // section grant, and none of those five routes may deliver one of these
      // two columns. Applied last, and to every branch, so a widening added
      // later cannot quietly reopen it.
      //
      // `section` is a base column with no deploy guard — the wholesale
      // sectionFilter above names it unconditionally for the same reason.
      q = q.not('section', 'in', `(${SECTIONS_HIDDEN_FROM_EMPLOYEES.join(',')})`);
      // Pinned first — that is what pinning is FOR; then newest, as before.
      // Ordering here rather than in the client means every view (grid, list,
      // kanban, My Files) agrees without each remembering to sort.
      if (withPin) q = q.order('is_pinned', { ascending: false });
      return q.order('created_at', { ascending: false });
    })) ?? [];
  if (rows.length === 0) return [];

  const [settings, tasksByFile, ownTasksByFile, contactMap, memberMap, layoutByType] =
    await Promise.all([
      getCompanyColorSettings(companyId),
      // AGGREGATE — every employee's open tasks per folder — so the color
      // matches what admins/managers and every other employee see for the
      // exact same folder.
      openTasksForColorByFile(rows.map((r) => r.id)),
      // PER-VIEWER — only this employee's own open tasks — for the badge.
      openTasksForColorByFile(rows.map((r) => r.id), userId),
      contactNamesByIds(rows.map((r) => r.client_contact_id)),
      memberNamesByIds(rows.map((r) => r.folder_leader_id)),
      folderTypeLayoutsByKey(),
    ]);
  const now = new Date();
  return rows.map((r) => {
    const file = mapRow(
      r,
      tasksByFile.get(r.id) ?? [],
      settings,
      now,
      contactMap,
      memberMap,
      layoutByType
    );
    // The badge stays per-viewer even though the color above is now
    // aggregate — overwrite mapRow's (aggregate-derived) count with just this
    // employee's own unfinished tasks. A closed section still shows nothing.
    file.openTaskCount = isClosedSection(file.section)
      ? 0
      : (ownTasksByFile.get(r.id) ?? []).length;
    // Access-gate the Drive link: keep it only when the employee has a real
    // grant to THIS file; a task-only file (no grant) must not leak the link.
    if (!grantedIds.has(r.id)) file.driveLink = null;
    return file;
  });
}

/**
 * Is this file one of the employee's OWN — i.e. do they hold an access grant to
 * it, or are they the assignee of a task on it?
 *
 * The single-file counterpart of listFilesForEmployee, and deliberately the SAME
 * definition of "mine" so the Folders list and everything reachable from it
 * cannot disagree about which files an employee may see.
 *
 * WHY THIS EXISTS: the extra membership permissions (can_create_file,
 * can_edit_file, …) used to widen an employee to the WHOLE company's folders —
 * granting an employee the ability to create a folder also handed them every
 * other folder in the firm. Those grants now control what an employee may DO
 * with a folder, never which folders they can see.
 *
 * Mirrors listFilesForEmployee's deploy-safety: a missing tasks table (42P01)
 * degrades to access grants only rather than failing the request.
 */
export async function isFileAssignedToUser(
  fileId: string,
  userId: string
): Promise<boolean> {
  if (!fileId || !userId) return false;
  const supabase = getSupabaseAdmin();

  const accRes = await supabase
    .from('file_access')
    .select('file_id')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (accRes.error) throw new Error(accRes.error.message);
  if (accRes.data) return true;

  const taskRes = await supabase
    .from('tasks')
    .select('id')
    .eq('file_id', fileId)
    .eq('assignee_id', userId)
    .limit(1);
  if (taskRes.error) {
    if ((taskRes.error as { code?: string }).code === '42P01') return false;
    throw new Error(taskRes.error.message);
  }
  return ((taskRes.data as { id: string }[] | null) ?? []).length > 0;
}

/** Give a user an access grant on a file (idempotent). */
export async function grantFileAccess(
  fileId: string,
  userId: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_access')
    .upsert({ file_id: fileId, user_id: userId }, { onConflict: 'file_id,user_id' });
  if (res.error) throw new Error(res.error.message);
}

/** One file by id, or null if it does not exist. Caller checks its company. */
export async function getFileById(
  id: string,
  viewer?: FileColorViewer
): Promise<PlatformFile | null> {
  const supabase = getSupabaseAdmin();
  const row = await runFileQuery<FileRow>((columns) =>
    supabase.from('files').select(columns).eq('id', id).maybeSingle()
  );
  if (!row) return null;
  const assigneeFilter = viewer && !viewer.aggregate ? viewer.userId : undefined;
  const [settings, tasksByFile, contactMap, memberMap, layoutByType] =
    await Promise.all([
      getCompanyColorSettings(row.company_id),
      openTasksForColorByFile([row.id], assigneeFilter),
      contactNamesByIds([row.client_contact_id]),
      memberNamesByIds([row.folder_leader_id]),
      folderTypeLayoutsByKey(),
    ]);
  return mapRow(
    row,
    tasksByFile.get(row.id) ?? [],
    settings,
    new Date(),
    contactMap,
    memberMap,
    layoutByType
  );
}

export interface CreateFileInput {
  companyId: string;
  /** 'case' → client + opponent; 'contract' → client only (opponent null). */
  folderType: FolderType;
  /** Legacy display name for files.client — the contact's resolved name. */
  client: string;
  /** The CRM contact chosen as the folder's client (required, same company). */
  clientContactId: string;
  opponent: string;
  opponentEn: string | null;
  opponentAr: string | null;
  /** Legacy display name for files.managing_lawyer — the member's resolved name. */
  managingLawyer: string;
  /** The company member chosen as the folder leader (required, same company). */
  folderLeaderId: string;
  driveLink: string | null;
  /** Only 'potential' or 'active' are creatable (expired is a move target). */
  section: 'potential' | 'active';
  createdBy: string;
  /** Case identity (migration #32). Null when not supplied. */
  caseNumber?: string | null;
  court?: string | null;
  caseLevel?: string | null;
}

/** Insert a new file. Authorization (admin-only) is enforced by the caller. */
export async function createFile(
  input: CreateFileInput
): Promise<PlatformFile> {
  const supabase = getSupabaseAdmin();
  const row = (await runFileQuery<FileRow>((columns, withType, withCase) =>
    supabase
      .from('files')
      .insert({
        company_id: input.companyId,
        client: input.client,
        client_contact_id: input.clientContactId,
        opponent: input.opponent,
        opponent_en: input.opponentEn,
        opponent_ar: input.opponentAr,
        managing_lawyer: input.managingLawyer,
        folder_leader_id: input.folderLeaderId,
        drive_link: input.driveLink,
        section: input.section,
        created_by: input.createdBy,
        // Omitted pre-migration; the column then does not exist at all.
        ...(withType ? { folder_type: input.folderType } : {}),
        ...(withCase
          ? {
              case_number: input.caseNumber ?? null,
              court: input.court ?? null,
              case_level: input.caseLevel ?? null,
            }
          : {}),
      })
      .select(columns)
      .single()
  )) as FileRow;
  // A freshly-created file has no tasks → computes as GREEN (closed) until a
  // task is added; still load settings so the color object is well-formed.
  const [settings, contactMap, memberMap, layoutByType] = await Promise.all([
    getCompanyColorSettings(input.companyId),
    contactNamesByIds([row.client_contact_id]),
    memberNamesByIds([row.folder_leader_id]),
    folderTypeLayoutsByKey(),
  ]);
  return mapRow(
    row,
    [],
    settings,
    new Date(),
    contactMap,
    memberMap,
    layoutByType
  );
}

/**
 * Move a file to a new section. Authorization (admin or manager of the file's
 * company) is enforced by the caller. Any of the three sections is a valid
 * target; the "no open tasks before expiring" guard arrives with tasks
 * (Phase 4), so the move is allowed unconditionally for now.
 */
export async function moveFileSection(
  id: string,
  section: FileSection
): Promise<PlatformFile | null> {
  const supabase = getSupabaseAdmin();
  const row = await runFileQuery<FileRow>((columns) =>
    supabase
      .from('files')
      .update({ section })
      .eq('id', id)
      .select(columns)
      .maybeSingle()
  );
  if (!row) return null;
  const [settings, tasksByFile, contactMap, memberMap, layoutByType] =
    await Promise.all([
      getCompanyColorSettings(row.company_id),
      openTasksForColorByFile([row.id]),
      contactNamesByIds([row.client_contact_id]),
      memberNamesByIds([row.folder_leader_id]),
      folderTypeLayoutsByKey(),
    ]);
  return mapRow(
    row,
    tasksByFile.get(row.id) ?? [],
    settings,
    new Date(),
    contactMap,
    memberMap,
    layoutByType
  );
}

/**
 * Partial edit of a file's fields. Only keys present (not `undefined`) are
 * written. Core-info fields (client/opponent/managingLawyer/driveLink) are
 * ADMIN-only and `section` is admin-or-manager — but that gating is enforced by
 * the API route BEFORE calling this. Values are assumed already trimmed and
 * validated by the caller. Returns the updated + color-mapped file, or null if
 * the id does not exist / nothing to update.
 */
export interface UpdateFileInput {
  folderType?: FolderType;
  client?: string;
  clientContactId?: string;
  opponent?: string;
  opponentEn?: string | null;
  opponentAr?: string | null;
  managingLawyer?: string;
  folderLeaderId?: string;
  driveLink?: string | null;
  section?: FileSection;
  caseNumber?: string | null;
  court?: string | null;
  caseLevel?: string | null;
  isGeneral?: boolean;
  /** Migration #33. Pinning is admin/manager-only — enforced by the route. */
  isPinned?: boolean;
  /** Migration #33. null clears the second type; a key sets it. */
  folderType2?: string | null;
}

export async function updateFileFields(
  id: string,
  patch: UpdateFileInput
): Promise<PlatformFile | null> {
  const update: Record<string, unknown> = {};
  if (patch.client !== undefined) update.client = patch.client;
  // folder_type is applied separately below (it must be dropped from the
  // payload when the column does not exist yet).
  if (patch.clientContactId !== undefined)
    update.client_contact_id = patch.clientContactId;
  if (patch.opponent !== undefined) update.opponent = patch.opponent;
  if (patch.opponentEn !== undefined) update.opponent_en = patch.opponentEn;
  if (patch.opponentAr !== undefined) update.opponent_ar = patch.opponentAr;
  if (patch.managingLawyer !== undefined)
    update.managing_lawyer = patch.managingLawyer;
  if (patch.folderLeaderId !== undefined)
    update.folder_leader_id = patch.folderLeaderId;
  if (patch.driveLink !== undefined) update.drive_link = patch.driveLink;
  if (patch.section !== undefined) update.section = patch.section;

  // The case details live behind their own capability flag (migration #32), so
  // they are assembled separately and dropped entirely when the columns are
  // absent — writing them would fail the whole update.
  const caseUpdate: Record<string, unknown> = {};
  if (patch.caseNumber !== undefined) caseUpdate.case_number = patch.caseNumber;
  if (patch.court !== undefined) caseUpdate.court = patch.court;
  if (patch.caseLevel !== undefined) caseUpdate.case_level = patch.caseLevel;
  if (patch.isGeneral !== undefined) caseUpdate.is_general = patch.isGeneral;

  // Pinning + the second folder type (migration #33) get their own group for
  // the same reason the case details do: they arrived in a later migration, and
  // naming a column the database has not got yet fails the WHOLE update — an
  // edit to the client name would be lost because of an unrelated new field.
  const pinUpdate: Record<string, unknown> = {};
  if (patch.isPinned !== undefined) pinUpdate.is_pinned = patch.isPinned;
  if (patch.folderType2 !== undefined)
    pinUpdate.folder_type_2 = patch.folderType2;

  // Nothing to change — return the current row untouched.
  if (
    Object.keys(update).length === 0 &&
    Object.keys(caseUpdate).length === 0 &&
    Object.keys(pinUpdate).length === 0 &&
    patch.folderType === undefined
  ) {
    return getFileById(id);
  }

  const supabase = getSupabaseAdmin();
  const row = await runFileQuery<FileRow>(
    (columns, withType, withCase, withPin) =>
      supabase
        .from('files')
        .update({
          ...update,
          ...(withType && patch.folderType !== undefined
            ? { folder_type: patch.folderType }
            : {}),
          ...(withCase ? caseUpdate : {}),
          ...(withPin ? pinUpdate : {}),
        })
        .eq('id', id)
        .select(columns)
        .maybeSingle()
  );
  if (!row) return null;
  const [settings, tasksByFile, contactMap, memberMap, layoutByType] =
    await Promise.all([
      getCompanyColorSettings(row.company_id),
      openTasksForColorByFile([row.id]),
      contactNamesByIds([row.client_contact_id]),
      memberNamesByIds([row.folder_leader_id]),
      folderTypeLayoutsByKey(),
    ]);
  return mapRow(
    row,
    tasksByFile.get(row.id) ?? [],
    settings,
    new Date(),
    contactMap,
    memberMap,
    layoutByType
  );
}

/**
 * Permanently delete a file (folder) and EVERYTHING that depends on it.
 *
 * The whole dependency graph is declared `on delete cascade` at the DB level, so
 * a single delete of the `files` row atomically removes, in one transaction:
 *   • tasks (file_id)            → task_events (task_id), notifications (task_id)
 *   • file_access (file_id)
 *   • access_requests (file_id)
 * There is therefore NO hand-ordered delete and no orphan risk — Postgres runs
 * the cascade as one statement. Authorization (ADMIN ONLY) + company isolation
 * are enforced by the API route BEFORE calling this.
 *
 * Returns true if a row was deleted, false if the id did not exist.
 */
export async function deleteFileById(id: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('files')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data !== null;
}
