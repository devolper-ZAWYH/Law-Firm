'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { STRINGS, dirForLang, type Lang, type Strings } from '@/lib/i18n';
import NotificationsBell from './NotificationsBell';
import RelatedWebsitesModal from './RelatedWebsitesModal';

/**
 * Platform dashboard shell (Phase 1).
 *
 * Renders the Coffee & Cardamom sidebar/topbar, a COMPANY SWITCHER, and a
 * role-resolved navigation. The role that drives the nav is the caller's role
 * IN THE ACTIVE COMPANY:
 *   • admin    → all companies in the switcher + full admin nav
 *   • manager  → only his companies + manager nav
 *   • employee → no switcher (one company) + employee nav
 *
 * Authorization itself is enforced server-side (see lib/platform/auth.ts); this
 * component only decides what to *render*.
 */

export type ShellRole = 'admin' | 'manager' | 'employee';

export interface ShellCompany {
  id: string;
  nameEn: string;
  nameAr: string;
  role: ShellRole;
  /**
   * True if the user holds a MANAGER membership here, independent of admin. The
   * shell uses it to surface manager-operator affordances (My Tasks / Employee
   * Tasks nav; Add-task in a file) for a global admin who also manages.
   */
  isManager: boolean;
  /** True if this membership was granted at least one extra permission. */
  hasFilePermission: boolean;
  /** Granted any of the 'company.contacts*' keys — gates the CRM link. */
  hasCrmPermission?: boolean;
  /** May open the Collections portal — gates its sidebar link. */
  hasCollectionsAccess?: boolean;
  /** True if this membership was granted can_upload_attendance. */
  hasAttendancePermission: boolean;
}

export interface ShellIdentity {
  userId: string;
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
  isAdmin: boolean;
}

interface DashCtx {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: Strings;
  toggleLang: () => void;
  identity: ShellIdentity;
  /**
   * The company the switcher currently points at (undefined only if the caller
   * has no companies at all). Feature views read this to scope their data;
   * switching the company re-renders them.
   */
  activeCompany: ShellCompany | undefined;
  /** All companies the caller may switch between. */
  companies: ShellCompany[];
}

const Ctx = createContext<DashCtx | null>(null);

export function useDash(): DashCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDash must be used within DashboardShell');
  return v;
}

const LANG_KEY = 'albaker_lang';
const ACTIVE_COMPANY_KEY = 'albaker_active_company';
const COLLAPSE_KEY = 'albaker_sidebar_collapsed';
const TASKS_OPEN_KEY = 'albaker_tasks_group_open';

// ---- tiny inline line icons ----
const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const GridIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </svg>
);
const UsersIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const FileIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);
const ContactsIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M4 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z" />
    <circle cx="11" cy="10" r="2.5" />
    <path d="M7.5 16a3.5 3.5 0 0 1 7 0" />
  </svg>
);
// Collections — a banknote, for the debt-recovery portal.
const CollectionsIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 9.5v5M18 9.5v5" />
  </svg>
);
const KeyIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="7.5" cy="15.5" r="3.5" />
    <path d="M10 13l8-8M15 5l2 2M19 9l2-2" />
  </svg>
);
const GearIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const BookIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);
/** A four-point spark — the conventional "AI" mark, and distinct from every
 *  other glyph in this sidebar so the one outbound link is recognisable. */
const SparkIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    <path d="M18 16l.7 2.1L21 19l-2.3.9L18 22l-.7-2.1L15 19l2.3-.9L18 16z" />
  </svg>
);
const CheckSquareIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);
const BuildingIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M9 8h2M9 12h2M9 16h2" />
    <path d="M15 21V9h2a2 2 0 0 1 2 2v10" />
  </svg>
);
const GlobeIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" />
  </svg>
);
const LogoutIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </svg>
);
const MenuIcon = () => (
  <svg {...iconProps} width={20} height={20} aria-hidden="true">
    <path d="M3 12h18M3 6h18M3 18h18" />
  </svg>
);
const PanelIcon = () => (
  <svg {...iconProps} width={18} height={18} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);
const ChevronIcon = () => (
  <svg {...iconProps} width={14} height={14} aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

function LiveClock({ label }: { label: string }) {
  const [time, setTime] = useState<string>('--:--:--');
  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="dash-live">
      <span className="dash-live-dot" aria-hidden="true" />
      <span>
        {label} · <span dir="ltr">{time}</span>
      </span>
    </div>
  );
}

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: ReactNode;
  /** Leaves the portal — rendered as a plain anchor opening a new tab. */
  external?: boolean;
  /**
   * Opens the "Related websites" card instead of navigating. `href` is unused
   * for such an entry and is left empty.
   *
   * This row used to be a single external link straight to albaker.ai. One
   * hard-coded destination could not grow with the firm, and the other sites
   * were reachable only by knowing the address — so the row now opens a card
   * listing them all, each with a direct link. See RelatedWebsitesModal.
   */
  opensWebsites?: boolean;
}

/**
 * A collapsible parent group (Notion-style section) that reveals a set of child
 * links. Rendered as a toggle button; when the WHOLE sidebar is collapsed via
 * `.is-collapsed` the sidebar slides off-screen entirely, so the group needs no
 * special icon-rail handling — it behaves like every other nav entry.
 */
interface NavGroup {
  key: string;
  label: string;
  icon: ReactNode;
  children: NavItem[];
}

type NavEntry = NavItem | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return (e as NavGroup).children !== undefined;
}

/**
 * Build the nav for a given effective role in the active company.
 *
 * Tasks live under a single collapsible "Tasks" group with two children:
 *   • My Tasks       — a person's own tasks + tasks awaiting their approval.
 *                      Shown to everyone who reaches the admin shell.
 *   • Employee Tasks — the company-wide oversight view. Restricted to MANAGERS
 *                      of the active company and global ADMINS; the child is
 *                      simply omitted for anyone else so it never leaks in the
 *                      sidebar (the route + API re-enforce this server-side).
 *
 * `role` is the caller's effective role in the active company; a global admin
 * resolves to 'admin' and always qualifies for the oversight child.
 */
function buildNav(
  role: ShellRole,
  t: Strings,
  lang: Lang,
  hasFilePermission: boolean,
  hasAttendancePermission: boolean,
  hasCrmPermission: boolean
): NavEntry[] {
  const tasksGroup: NavGroup = {
    key: 'tasks',
    label: lang === 'ar' ? 'المهام' : 'Tasks',
    icon: <CheckSquareIcon />,
    children: [
      // My Tasks — available to every role that reaches the admin shell.
      { key: 'mytasks', href: '/admin/mytasks', label: t.navMyTasks, icon: <CheckSquareIcon /> },
      // Employee Tasks — managers of this company + admins only.
      ...(role === 'manager' || role === 'admin'
        ? [
            {
              key: 'emptasks',
              href: '/admin/emptasks',
              label: t.navEmployeeTasks,
              icon: <UsersIcon />,
            },
          ]
        : []),
    ],
  };

  if (role === 'admin') {
    return [
      { key: 'overview', href: '/admin', label: t.overview, icon: <GridIcon /> },
      { key: 'files', href: '/admin/files', label: t.navFiles, icon: <FileIcon /> },
      tasksGroup,
      { key: 'contacts', href: '/admin/contacts', label: t.navContacts, icon: <ContactsIcon /> },
      { key: 'employees', href: '/admin/employees', label: t.navEmployees, icon: <UsersIcon /> },
      { key: 'attendance', href: '/admin/attendance', label: t.navAttendance, icon: <UsersIcon /> },
      { key: 'access', href: '/admin/access', label: t.navAccessRequests, icon: <KeyIcon /> },
      // Approvals — held capability actions. Shown to admins and managers; the
      // page itself reports "not the approver" for a manager the admin has not
      // assigned, rather than being hidden and leaving them to wonder.
      { key: 'approvals', href: '/admin/approvals', label: t.navApprovals, icon: <KeyIcon /> },
      // Legacy "User Management" (/admin/users) — nav link hidden per request.
      // The page, route, API, and user data remain intact so it can be restored
      // by simply un-commenting this entry. Hides the label in EN + AR at once.
      // { key: 'accounts', href: '/admin/users', label: t.navUserAccounts, icon: <UsersIcon /> },
      { key: 'settings', href: '/admin/settings', label: t.navSettings, icon: <GearIcon /> },
      { key: 'instructions', href: '/admin/instructions', label: t.navInstructions, icon: <BookIcon /> },
    { key: 'websites', href: '', label: t.navRelatedWebsites, icon: <SparkIcon />, opensWebsites: true },
    ];
  }
  if (role === 'manager') {
    return [
      { key: 'overview', href: '/admin', label: t.overview, icon: <GridIcon /> },
      { key: 'files', href: '/admin/files', label: t.navFiles, icon: <FileIcon /> },
      tasksGroup,
      // CRM (Contacts) — managers may now add clients to the directory.
      { key: 'contacts', href: '/admin/contacts', label: t.navContacts, icon: <ContactsIcon /> },
      { key: 'employees', href: '/admin/employees', label: t.navEmployees, icon: <UsersIcon /> },
      { key: 'attendance', href: '/admin/attendance', label: t.navAttendance, icon: <UsersIcon /> },
      { key: 'approvals', href: '/admin/approvals', label: t.navApprovals, icon: <KeyIcon /> },
      { key: 'settings', href: '/admin/settings', label: t.navSettings, icon: <GearIcon /> },
      { key: 'instructions', href: '/admin/instructions', label: t.navInstructions, icon: <BookIcon /> },
    { key: 'websites', href: '', label: t.navRelatedWebsites, icon: <SparkIcon />, opensWebsites: true },
    ];
  }
  // employee
  //
  // Employees have no "Tasks" group (Employee Tasks is manager/admin-only, and a
  // collapsible parent wrapping a single "My Tasks" child would be pointless).
  // Instead they get a direct top-level "My Tasks" link next to My Files. It
  // hits /me?f=tasks → MyTasksView, whose data comes from /api/tasks/mine and
  // /api/tasks/awaiting-approval — both scoped server-side to the caller's own
  // identity, so an employee only ever sees THEIR assigned tasks + tasks
  // awaiting their approval, never another user's or company's.
  //
  // MY TASKS COMES FIRST, and it is what /me lands on. What an employee opens
  // the portal to find out is what they have been asked to do; their folders
  // are how they then do it. The order and the landing have to agree, or the
  // first item in the list is never the one highlighted on arrival.
  return [
    { key: 'mytasks', href: '/me', label: t.navMyTasks, icon: <CheckSquareIcon /> },
    { key: 'myfiles', href: '/me?f=files', label: t.navMyFiles, icon: <FileIcon /> },
    // Folders — only for an employee GRANTED an extra permission in the active
    // company (lib/platform/permissions.ts). Points at the same admin Folders
    // screen managers use; server-side checks scope what they can actually do.
    ...(hasFilePermission
      ? [{ key: 'files', href: '/admin/files', label: t.navFiles, icon: <FileIcon /> }]
      : []),
    // CRM — only for an employee granted 'company.contacts' (read the client
    // directory), 'company.contactsAdd' (add to it) or 'company.contactsEdit'
    // (change an entry). Without this the permissions could be ticked and
    // nothing appeared: the page was reachable by URL but was in nobody's
    // sidebar, so granting them looked like a no-op.
    ...(hasCrmPermission
      ? [
          {
            key: 'contacts',
            href: '/admin/contacts',
            label: t.navContacts,
            icon: <ContactsIcon />,
          },
        ]
      : []),
    // Attendance — only for an employee GRANTED can_upload_attendance.
    ...(hasAttendancePermission
      ? [
          {
            key: 'attendance',
            href: '/admin/attendance',
            label: t.navAttendance,
            icon: <UsersIcon />,
          },
        ]
      : []),
    { key: 'instructions', href: '/me?f=instructions', label: t.navInstructions, icon: <BookIcon /> },
    { key: 'websites', href: '', label: t.navRelatedWebsites, icon: <SparkIcon />, opensWebsites: true },
  ];
}

export default function DashboardShell({
  identity,
  companies,
  active,
  wide = false,
  children,
}: {
  identity: ShellIdentity;
  companies: ShellCompany[];
  /** Key of the active nav item (e.g. 'overview', 'accounts', 'files'). */
  active: string;
  /**
   * Drop the 900px reading-width cap and let the page use the window.
   *
   * 900px is right for the pages this shell was built for — forms, tables and
   * prose, where a longer line is a worse line. It is wrong for a screen whose
   * content is a SEVEN-COLUMN GRID carrying a row per person: the workload
   * calendar was being squeezed into 128px-wide days, which is narrower than
   * the "0/8h" it has to print, while a third of the window sat empty beside
   * it.
   *
   * Opt-in per page rather than inferred from the content, so a page states
   * plainly which of the two it is.
   */
  wide?: boolean;
  children: ReactNode;
}) {
  const [lang, setLang] = useState<Lang>('ar'); // Arabic is the default
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // desktop sidebar collapse (Notion-style)
  const [tasksOpen, setTasksOpen] = useState(true); // Tasks group expanded by default
  // The "Related websites" card. Not persisted — it is a jumping-off point, and
  // reopening the app into a modal nobody asked for would be a bug.
  const [showWebsites, setShowWebsites] = useState(false);
  const router = useRouter();
  const dir = dirForLang(lang);
  const t = STRINGS[lang];

  // Active company context (persisted). Fall back to the first company.
  const firstCompanyId = companies[0]?.id ?? '';
  const [activeCompanyId, setActiveCompanyId] = useState<string>(firstCompanyId);

  // Restore persisted language + active company on mount.
  useEffect(() => {
    try {
      const storedLang = window.localStorage.getItem(LANG_KEY) as Lang | null;
      if (storedLang === 'en' || storedLang === 'ar') setLang(storedLang);
      const storedCompany = window.localStorage.getItem(ACTIVE_COMPANY_KEY);
      if (storedCompany && companies.some((c) => c.id === storedCompany)) {
        setActiveCompanyId(storedCompany);
      }
      const storedCollapsed = window.localStorage.getItem(COLLAPSE_KEY);
      if (storedCollapsed === '1') setCollapsed(true);
      const storedTasksOpen = window.localStorage.getItem(TASKS_OPEN_KEY);
      if (storedTasksOpen === '0') setTasksOpen(false);
    } catch {
      /* ignore */
    }
    // companies is stable for a given render of a page; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
  }, [dir, lang]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASKS_OPEN_KEY, tasksOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [tasksOpen]);

  function toggleLang() {
    setLang((prev) => {
      const next: Lang = prev === 'en' ? 'ar' : 'en';
      try {
        window.localStorage.setItem(LANG_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function onSwitchCompany(id: string) {
    setActiveCompanyId(id);
    try {
      window.localStorage.setItem(ACTIVE_COMPANY_KEY, id);
    } catch {
      /* ignore */
    }
    // Client feature views already re-fetch because their data effects key on
    // activeCompany.id (which changes above). router.refresh() additionally
    // re-runs Server Components for the current route so any server-rendered
    // data (e.g. the overview) reflects the newly-selected company immediately,
    // without a manual page reload. It does NOT reset client state, so the
    // persisted active-company selection is preserved.
    router.refresh();
  }

  async function signOut() {
    try {
      const res = await fetch('/api/logout', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { revoked?: boolean };
      // The cookie is cleared regardless, so this browser is signed out either
      // way. `revoked: false` means the server could not invalidate tokens
      // already issued — anyone holding a copy of this session keeps access
      // until it expires. Say so rather than reporting a clean sign-out.
      if (data.revoked === false) {
        window.alert(
          lang === 'ar'
            ? 'تم تسجيل الخروج من هذا الجهاز، لكن تعذّر إنهاء الجلسات الأخرى. يرجى إبلاغ المسؤول.'
            : 'Signed out on this device, but other sessions could not be ended. Please tell your administrator.'
        );
      }
    } finally {
      window.location.assign('/login');
    }
  }

  // Resolve the active company (guard against an empty list defensively).
  const activeCompany =
    companies.find((c) => c.id === activeCompanyId) ?? companies[0];
  const effectiveRole: ShellRole = activeCompany?.role ?? 'employee';

  const nav = useMemo(
    () =>
      buildNav(
        effectiveRole,
        t,
        lang,
        activeCompany?.hasFilePermission ?? false,
        activeCompany?.hasAttendancePermission ?? false,
        activeCompany?.hasCrmPermission ?? false
      ),
    [
      effectiveRole,
      t,
      lang,
      activeCompany?.hasFilePermission,
      activeCompany?.hasAttendancePermission,
      activeCompany?.hasCrmPermission,
    ]
  );
  // Flatten groups → links so the topbar label can resolve a child (e.g. a
  // Tasks sub-item) the same way it resolves a top-level nav item.
  const flatNav = useMemo(
    () => nav.flatMap((e) => (isGroup(e) ? e.children : [e])),
    [nav]
  );
  const currentLabel =
    flatNav.find((n) => n.key === active)?.label ?? t.overview;

  // Whether the active route lives inside the Tasks group — used to auto-expand
  // it so the active child is never hidden behind a collapsed toggle.
  const activeInTasks = useMemo(
    () =>
      nav.some((e) => isGroup(e) && e.children.some((c) => c.key === active)),
    [nav, active]
  );
  useEffect(() => {
    if (activeInTasks) setTasksOpen(true);
  }, [activeInTasks]);

  const companyName = (c: ShellCompany) => (lang === 'ar' ? c.nameAr : c.nameEn);
  const displayName =
    (lang === 'ar' ? identity.fullNameAr : identity.fullNameEn) ||
    identity.fullNameEn ||
    identity.username;

  // Show the switcher only when there is a real choice to make.
  const showSwitcher = companies.length > 1;

  return (
    <Ctx.Provider
      value={{ lang, dir, t, toggleLang, identity, activeCompany, companies }}
    >
      <div
        className={`dash${open ? ' is-open' : ''}${
          collapsed ? ' is-collapsed' : ''
        }`}
      >
        <aside className="dash-sidebar" aria-label="Sidebar">
          <button
            type="button"
            className="dash-collapse-side"
            aria-label={lang === 'ar' ? 'إخفاء الشريط الجانبي' : 'Hide sidebar'}
            onClick={() => setCollapsed(true)}
          >
            <PanelIcon />
          </button>
          <div className="dash-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/albaker-logo.png"
              alt="Ali AlBaker Law Firm"
              width={720}
              height={415}
            />
            <span className="dash-brand-label">{t.dashboard}</span>
          </div>

          {/* Company switcher */}
          {showSwitcher && (
            <div className="dash-switcher">
              <label className="dash-eyebrow" htmlFor="company-switcher">
                {t.activeCompany}
              </label>
              <div className="dash-switcher-control">
                <span className="dash-switcher-icon" aria-hidden="true">
                  <BuildingIcon />
                </span>
                <select
                  id="company-switcher"
                  className="dash-switcher-select"
                  value={activeCompany?.id ?? ''}
                  onChange={(e) => onSwitchCompany(e.target.value)}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {companyName(c)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <nav className="dash-nav-wrap">
            <div className="dash-eyebrow dash-views-label">{t.views}</div>
            <ul className="dash-nav">
              {nav.map((entry) =>
                isGroup(entry) ? (
                  <li key={entry.key} className="dash-nav-group">
                    <button
                      type="button"
                      className={`dash-nav-item dash-nav-toggle${
                        activeInTasks ? ' is-active-parent' : ''
                      }`}
                      aria-expanded={tasksOpen}
                      onClick={() => setTasksOpen((v) => !v)}
                    >
                      <span className="dash-nav-icon">{entry.icon}</span>
                      <span>{entry.label}</span>
                      <span className="dash-nav-caret" aria-hidden="true">
                        <ChevronIcon />
                      </span>
                    </button>
                    {tasksOpen && (
                      <ul className="dash-nav dash-nav-sub">
                        {entry.children.map((child) => (
                          <li key={child.key}>
                            <Link
                              href={child.href}
                              className={`dash-nav-item dash-nav-subitem${
                                active === child.key ? ' is-active' : ''
                              }`}
                              aria-current={
                                active === child.key ? 'page' : undefined
                              }
                            >
                              <span className="dash-nav-icon">{child.icon}</span>
                              <span>{child.label}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ) : (
                  <li key={entry.key}>
                    {entry.opensWebsites ? (
                      <button
                        type="button"
                        className="dash-nav-item"
                        onClick={() => setShowWebsites(true)}
                      >
                        <span className="dash-nav-icon">{entry.icon}</span>
                        <span>{entry.label}</span>
                      </button>
                    ) : entry.external ? (
                      <a
                        href={entry.href}
                        className="dash-nav-item"
                        target="_blank"
                        // noreferrer as well as noopener: the destination is a
                        // separate product and has no need to be handed this
                        // app's URL.
                        rel="noopener noreferrer"
                      >
                        <span className="dash-nav-icon">{entry.icon}</span>
                        <span>{entry.label}</span>
                      </a>
                    ) : (
                      <Link
                        href={entry.href}
                        className={`dash-nav-item${
                          active === entry.key ? ' is-active' : ''
                        }`}
                        aria-current={active === entry.key ? 'page' : undefined}
                      >
                        <span className="dash-nav-icon">{entry.icon}</span>
                        <span>{entry.label}</span>
                      </Link>
                    )}
                  </li>
                )
              )}
            </ul>
          </nav>

          <div className="dash-sidebar-footer">
            <div className="dash-identity">
              <div className="dash-identity-name">{displayName}</div>
              {identity.isAdmin ? (
                <span className="dash-identity-role dash-identity-admin">
                  {t.globalAdmin}
                </span>
              ) : activeCompany ? (
                <span className="dash-identity-role">
                  {effectiveRole === 'manager' ? t.roleManager : t.roleEmployee}
                </span>
              ) : null}
            </div>
            <LiveClock label={t.live} />
            <NotificationsBell lang={lang} />
            {/* COLLECTIONS — the way into the second portal, for anyone who may
                open it. It sits here rather than in the nav above because it
                LEAVES this shell: the list above is the pages this sidebar
                owns, and a link that swaps the whole portal is a different kind
                of thing, so it keeps company with the other cross-cutting
                controls. The link only draws a control — app/collections/guard
                re-decides the same question server-side. */}
            {(activeCompany?.hasCollectionsAccess ?? false) && (
              <a href="/collections" className="dash-foot-btn">
                <span className="dash-nav-icon">
                  <CollectionsIcon />
                </span>
                <span>{t.plPortal}</span>
              </a>
            )}
            <button type="button" className="dash-foot-btn" onClick={toggleLang}>
              <span className="dash-nav-icon">
                <GlobeIcon />
              </span>
              <span>{lang === 'en' ? 'العربية' : 'English'}</span>
            </button>
            <button type="button" className="dash-foot-btn" onClick={signOut}>
              <span className="dash-nav-icon">
                <LogoutIcon />
              </span>
              <span>{t.signOut}</span>
            </button>
          </div>
        </aside>

        {/* click-away scrim for mobile drawer */}
        <button
          type="button"
          className="dash-scrim"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />

        <div className="dash-main">
          <div className="dash-topbar">
            <button
              type="button"
              className="dash-menu-btn"
              aria-label={t.menu}
              onClick={() => setOpen((v) => !v)}
            >
              <MenuIcon />
            </button>
            <button
              type="button"
              className="dash-collapse-btn"
              aria-label={
                collapsed
                  ? lang === 'ar'
                    ? 'إظهار الشريط الجانبي'
                    : 'Show sidebar'
                  : lang === 'ar'
                  ? 'إخفاء الشريط الجانبي'
                  : 'Hide sidebar'
              }
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((v) => !v)}
            >
              <PanelIcon />
            </button>
            <span className="dash-topbar-view">{currentLabel}</span>
          </div>
          <div className={`dash-content${wide ? ' is-wide' : ''}`}>{children}</div>
        </div>

        {showWebsites && (
          <RelatedWebsitesModal
            lang={lang}
            onClose={() => setShowWebsites(false)}
          />
        )}
      </div>
    </Ctx.Provider>
  );
}
