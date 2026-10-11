import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { hasCollectionsRole } from '@/lib/platform/auth';

/**
 * The second portal is called COLLECTIONS, lives at /collections, and is
 * reachable from the main portal's sidebar.
 *
 * Three things are pinned here, because each one broke something real:
 *
 *   1. WHO SEES THE LINK. Until it existed, the only way into the portal was
 *      the chooser on the sign-in screen — someone already signed in had to
 *      sign out to reach a portal they had access to.
 *   2. A MISSING MIGRATION GRANTS NOTHING. `paylaterRole` is `undefined` when
 *      migration #35 has not run. That is not "no role"; it is "unknown", and
 *      a read that could not prove access must never hand it out.
 *   3. THE OLD PATH STILL WORKS. /paylater was shipped; bookmarks and links
 *      exist, so it forwards rather than 404s.
 */

describe('who may open Collections', () => {
  it('grants entry to a membership holding a Collections role', () => {
    expect(hasCollectionsRole('team_leader')).toBe(true);
    expect(hasCollectionsRole('employee')).toBe(true);
    expect(hasCollectionsRole('lawyer')).toBe(true);
    expect(hasCollectionsRole('auditor')).toBe(true);
  });

  it('grants nothing when no role is assigned', () => {
    expect(hasCollectionsRole(null)).toBe(false);
    expect(hasCollectionsRole('')).toBe(false);
  });

  it('grants NOTHING when the column could not be read', () => {
    // undefined = migration #35 has not run. Unknown must never read as
    // permitted, or a database that is merely behind would open the portal to
    // everyone with a membership.
    expect(hasCollectionsRole(undefined)).toBe(false);
  });
});

describe('the sidebar link', () => {
  const shell = readFileSync('components/DashboardShell.tsx', 'utf8');

  it('is gated on hasCollectionsAccess, not drawn for everyone', () => {
    expect(shell).toMatch(
      /hasCollectionsAccess \?\? false\)[\s\S]{0,600}?href="\/collections"/
    );
  });

  it('points at the new path', () => {
    expect(shell).toContain('href="/collections"');
    expect(shell).not.toContain('href="/paylater"');
  });

  it('sits ABOVE the language toggle in the sidebar footer', () => {
    // Asked for by position, not just presence: it belongs with the
    // cross-cutting controls at the bottom, immediately before the language
    // button — not buried in the page list above.
    const link = shell.indexOf('href="/collections"');
    const lang = shell.indexOf('onClick={toggleLang}');
    const signOut = shell.indexOf('onClick={signOut}');
    expect(link).toBeGreaterThan(-1);
    expect(lang).toBeGreaterThan(-1);
    expect(link).toBeLessThan(lang);
    // ...and inside the footer, so "above language" cannot be satisfied by
    // something sitting at the top of the file.
    expect(shell.indexOf('dash-sidebar-footer')).toBeLessThan(link);
    expect(link).toBeLessThan(signOut);
  });
});

describe('the rename', () => {
  it('moved the routes to app/collections', () => {
    expect(existsSync('app/collections/page.tsx')).toBe(true);
    expect(existsSync('app/paylater')).toBe(false);
  });

  it('keeps the old /paylater path working, permanently', () => {
    const cfg = readFileSync('next.config.js', 'utf8');
    expect(cfg).toContain("source: '/paylater'");
    expect(cfg).toContain("destination: '/collections'");
    expect(cfg).toContain("source: '/paylater/:path*'");
  });

  it('leaves the API paths and table names alone', () => {
    // Stored and wired names are permanent; renaming them is how access
    // quietly breaks. Only what a person READS becomes "Collections".
    expect(existsSync('app/api/paylater')).toBe(true);
    const migration = readFileSync(
      'supabase/migrations/20260101000034_paylater.sql',
      'utf8'
    );
    expect(migration).toContain('paylater_customers');
  });

  it('says Collections where a person can see it', () => {
    const i18n = readFileSync('lib/i18n.ts', 'utf8');
    expect(i18n).toContain("plPortal: 'Collections'");
    expect(i18n).toContain("plPortal: 'التحصيل'");
  });

  it('leaves no page route pointing at /paylater', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          // The API keeps its paylater paths on purpose.
          if (full === 'app/api') continue;
          walk(full);
        } else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          if (/(['"`])\/paylater(?=['"`/?])/.test(src)) offenders.push(full);
        }
      }
    };
    walk('app');
    walk('components');
    expect(offenders).toEqual([]);
  });
});

describe('the portal ships empty', () => {
  it('seeds no customers, batches or orders in any migration', () => {
    // "Remove the data" for a fresh deploy means: a migration must never carry
    // rows. The only insert in the Collections migrations creates a storage
    // BUCKET, which is configuration, not client data.
    const dir = 'supabase/migrations';
    for (const name of readdirSync(dir)) {
      if (!name.includes('paylater')) continue;
      const sql = readFileSync(`${dir}/${name}`, 'utf8').toLowerCase();
      for (const table of [
        'paylater_customers',
        'paylater_batches',
        'paylater_orders',
        'paylater_documents',
      ]) {
        expect(sql).not.toContain(`insert into ${table}`);
      }
    }
  });

  it('never imports the real dataset as part of a build or start', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === 'import:paylater') continue;
      expect(cmd).not.toContain('import-paylater');
      expect(cmd).not.toContain('import:paylater');
    }
  });
});
