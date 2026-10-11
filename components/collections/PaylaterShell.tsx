'use client';

/**
 * The PayLater portal's shell.
 *
 * A SEPARATE shell from DashboardShell rather than a mode of it. The two
 * portals share a company, a sign-in and a look, but nothing else: this nav has
 * four entries against the other's fifteen, no company switcher (PayLater is
 * scoped to one company), and a portal switcher the other does not need. Adding
 * a "which portal am I?" branch to every part of DashboardShell would make the
 * busier of the two harder to read in order to save a layout that is fifty
 * lines long.
 *
 * The CSS classes ARE shared, deliberately — `dash-*` is the platform's layout
 * vocabulary, so the two portals stay visibly one product and a change to the
 * sidebar lands in both.
 *
 * Language is Arabic by default and persisted under the same key as the main
 * portal, so switching portals does not switch language back.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { STRINGS, dirForLang, type Lang, type Strings } from '@/lib/i18n';
import { paylaterRoleLabel, type PaylaterRole } from '@/lib/platform/paylaterRoles';

const LANG_KEY = 'albaker_lang';

/**
 * THE PORTAL'S ONE LANGUAGE. Everything below the shell reads it from here.
 *
 * Each view used to hold its own `lang`, seeded from localStorage at mount with
 * no way to change it. Toggling the language then updated the SIDEBAR and left
 * the body in the old language until a full reload — five copies of one piece
 * of state, four of which never heard that it changed.
 *
 * The shell owns it, publishes it here, and persists it. A view that needs the
 * language calls usePaylaterLang(); there is nowhere else to get it from, which
 * is what stops the copies growing back.
 */
interface PaylaterLangValue {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: Strings;
  /** True for Arabic — the common shorthand in these views. */
  ar: boolean;
}

const LangCtx = createContext<PaylaterLangValue>({
  lang: 'ar',
  dir: 'rtl',
  t: STRINGS.ar,
  ar: true,
});

export function usePaylaterLang(): PaylaterLangValue {
  return useContext(LangCtx);
}

export interface PaylaterShellIdentity {
  username: string;
  fullNameEn: string | null;
  fullNameAr: string | null;
  isAdmin: boolean;
}

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
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);
const SearchIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);
const FlagIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M4 21V4h10l-1 3h7v9h-8l-1-3H4" />
  </svg>
);
const SwapIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M7 4 3 8l4 4" />
    <path d="M3 8h13a4 4 0 0 1 0 8h-2" />
  </svg>
);
const GlobeIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
  </svg>
);
const LogoutIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M15 17l5-5-5-5" />
    <path d="M20 12H9" />
    <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
  </svg>
);
const MenuIcon = () => (
  <svg {...iconProps} width={20} height={20} aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export default function PaylaterShell({
  identity,
  role,
  byRole,
  active,
  wide = false,
  children,
}: {
  identity: PaylaterShellIdentity;
  /** The ONE PayLater role this person holds, or null for an admin/manager. */
  role: PaylaterRole | null;
  /** Reached the portal by being an admin or manager rather than by a grant. */
  byRole: boolean;
  active: 'dashboard' | 'search' | 'notes';
  wide?: boolean;
  children: ReactNode;
}) {
  const [lang, setLang] = useState<Lang>('ar'); // Arabic is the default
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const dir = dirForLang(lang);
  const t = STRINGS[lang];

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === 'en' || saved === 'ar') setLang(saved);
    } catch {
      /* private mode — the default is fine */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  function toggleLang() {
    const next: Lang = lang === 'en' ? 'ar' : 'en';
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      /* nothing to do — the toggle still works for this page */
    }
  }

  async function signOut() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  // Three entries, matching v2's actual shape: the dashboard IS the batch
  // folders, so a separate "Batches" link would be a second door to one room.
  const nav = [
    { key: 'dashboard', href: '/collections', label: t.plDashboard, icon: <GridIcon /> },
    { key: 'search', href: '/collections/search', label: t.plSearch, icon: <SearchIcon /> },
    { key: 'notes', href: '/collections/notes', label: t.plNotes, icon: <FlagIcon /> },
  ] as const;

  const displayName =
    (lang === 'ar' ? identity.fullNameAr : identity.fullNameEn) ||
    identity.fullNameEn ||
    identity.username;

  // The role line under the name. Someone here by role holds no PayLater grant,
  // and saying "Employee" for an admin would be wrong — so say how they got in.
  const roleLabel = byRole
    ? identity.isAdmin
      ? lang === 'ar'
        ? 'مسؤول'
        : 'Administrator'
      : lang === 'ar'
        ? 'مشرف'
        : 'Manager'
    : paylaterRoleLabel(role, lang);

  const currentLabel = nav.find((n) => n.key === active)?.label ?? t.plPortal;

  const langValue = useMemo<PaylaterLangValue>(
    () => ({ lang, dir, t, ar: lang === 'ar' }),
    [lang, dir, t]
  );

  return (
    <LangCtx.Provider value={langValue}>
    <div className={`dash${open ? ' is-open' : ''}`} dir={dir}>
      <aside className="dash-sidebar" aria-label="Sidebar">
        <div className="dash-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/albaker-logo.png"
            alt="Ali AlBaker Law Firm"
            width={720}
            height={415}
          />
          <span className="dash-brand-label">{t.plPortal}</span>
        </div>

        <nav className="dash-nav-wrap" aria-label={t.plPortal}>
          <ul className="dash-nav">
            {nav.map((n) => (
              <li key={n.key}>
                <a
                  href={n.href}
                  className={`dash-nav-item${active === n.key ? ' is-active' : ''}`}
                  aria-current={active === n.key ? 'page' : undefined}
                >
                  <span className="dash-nav-icon">{n.icon}</span>
                  <span>{n.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="dash-sidebar-footer">
          <div className="dash-identity">
            <div className="dash-identity-name">{displayName}</div>
            {roleLabel && (
              <span
                className={`dash-identity-role${
                  identity.isAdmin ? ' dash-identity-admin' : ''
                }`}
              >
                {roleLabel}
              </span>
            )}
          </div>

          {/*
            The portal switcher the spec asks for: nobody signs out to change
            portal. A plain link — the session already covers both, so there is
            nothing to re-authenticate.
          */}
          <button
            type="button"
            className="dash-foot-btn"
            onClick={() => router.push('/admin')}
          >
            <span className="dash-nav-icon">
              <SwapIcon />
            </span>
            <span>{t.plSwitchToMain}</span>
          </button>

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
          <span className="dash-topbar-view">{currentLabel}</span>
        </div>
        <div className={`dash-content${wide ? ' is-wide' : ''}`}>{children}</div>
      </div>
    </div>
    </LangCtx.Provider>
  );
}
