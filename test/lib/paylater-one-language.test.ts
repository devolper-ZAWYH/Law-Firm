import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE LANGUAGE FOR THE PORTAL, OWNED BY THE SHELL.
 *
 * Every PayLater view used to hold its own `lang`, seeded from localStorage at
 * mount with no setter. Toggling the language updated the SIDEBAR and left the
 * whole body in the old language until a full page reload — five copies of one
 * piece of state, four of which never heard it change.
 *
 * The shell now publishes it through context. These tests fail if a view starts
 * keeping its own copy again, which is the only way this bug comes back.
 */
const VIEWS = readdirSync(join(process.cwd(), 'components/collections'))
  .filter((f) => f.endsWith('.tsx') && f !== 'PaylaterShell.tsx');

const read = (f: string) =>
  readFileSync(join(process.cwd(), 'components/collections', f), 'utf8');

describe('the PayLater language lives in exactly one place', () => {
  it('has views to check (guards against the glob silently matching nothing)', () => {
    expect(VIEWS.length).toBeGreaterThan(3);
  });

  it('no view reads the language key from storage itself', () => {
    for (const f of VIEWS) {
      expect(read(f), f).not.toContain('albaker_lang');
    }
  });

  it('no view keeps its own language state', () => {
    for (const f of VIEWS) {
      expect(read(f), f).not.toMatch(/useState<Lang>/);
    }
  });

  it('every view that shows language-dependent text takes it from the shell', () => {
    for (const f of VIEWS) {
      const src = read(f);
      // A view either renders no translated text at all, or it consumes the
      // shared hook. Reaching STRINGS directly would reintroduce a second
      // source of truth that cannot react to the toggle.
      const usesLang = /\blang\b|\bt\.pl/.test(src);
      if (!usesLang) continue;
      const viaHook = src.includes('usePaylaterLang');
      const viaProp = /lang:\s*Lang/.test(src); // a child given the live value
      expect(viaHook || viaProp, `${f} must get the language from the shell`).toBe(true);
    }
  });

  it('the shell exports the hook the views depend on', () => {
    const shell = readFileSync(
      join(process.cwd(), 'components/collections/PaylaterShell.tsx'),
      'utf8'
    );
    expect(shell).toContain('export function usePaylaterLang');
    // The provider has to wrap the children, or the context never reaches them.
    expect(shell).toContain('<LangCtx.Provider');
    expect(shell).toContain('{children}');
  });
});

/**
 * Sorting the customer table. The third click matters: row_no is the numbering
 * the firm's Progress Report uses, so getting back to the batch's own order
 * after sorting by claim is how someone reconciles the screen with the report.
 */
describe('sorting the customer table', () => {
  const batch = read('BatchView.tsx');

  it('offers the numeric columns, and only those', () => {
    expect(batch).toMatch(/type SortKey =[^;]*'fileNo'/);
    expect(batch).toMatch(/type SortKey =[^;]*'qid'/);
    expect(batch).toMatch(/type SortKey =[^;]*'outstanding'/);
    expect(batch).toMatch(/type SortKey =[^;]*'orderCount'/);
  });

  it('cycles ascending, descending, then back to the batch order', () => {
    expect(batch).toContain("return { key, dir: 'asc' }");
    expect(batch).toContain("return { key, dir: 'desc' }");
    expect(batch).toMatch(/return null; \/\/ third click restores/);
  });

  it('sorts a missing value last in BOTH directions', () => {
    // A file with no claim recorded is not the smallest claim.
    expect(batch).toContain('if (x === null) return 1;');
    expect(batch).toContain('if (y === null) return -1;');
  });

  it('compares QIDs as padded strings, not numbers', () => {
    // B100 #23 is "045112026" — Number() would eat the leading zero, and the
    // lengths differ between batches.
    expect(batch).toMatch(/padStart\(12, '0'\)/);
  });

  it('copies before sorting, because rows is a prop', () => {
    expect(batch).toContain('return [...out].sort(');
  });
});

/**
 * MISSING DATA IS RED.
 *
 * The intake indicator started gold, on the argument that a flag true for every
 * record is noise. That was the wrong trade for this field: a file that cannot
 * produce a notice until somebody fills it in is not a nuance, and gold sat in
 * the same register as "worth noticing".
 *
 * It uses the SAME danger tokens as .form-error and .dash-alert-error, so the
 * portal says "wrong" in one colour rather than three.
 */
describe('missing intake data is shown in the danger colour', () => {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

  it('the danger chip reuses the app tokens rather than a new red', () => {
    const rule = css.slice(
      css.indexOf('.dash-chip-danger'),
      css.indexOf('.dash-chip-danger') + 200
    );
    expect(rule).toContain('var(--danger)');
    expect(rule).toContain('var(--danger-bg)');
  });

  it('the batch table marks an incomplete file red, and a complete one not', () => {
    const batch = readFileSync(
      join(process.cwd(), 'components/collections/BatchView.tsx'),
      'utf8'
    );
    // The status column is v2's tag now, so the assertion follows it: a file
    // with anything missing carries the RED tag, a finished one the green.
    // `.pl-tag.miss` is v2's #A33528 on #FBF1EF; `.pl-tag.done` its green.
    expect(batch).toContain('pl-tag miss');
    expect(batch).toContain('pl-tag done');
    expect(batch).not.toContain('pl-tag gold');
  });

  it('the dashboard counters are red too — intake is mandatory work', () => {
    const dash = readFileSync(
      join(process.cwd(), 'components/collections/PaylaterDashboard.tsx'),
      'utf8'
    );
    // The per-batch line, now v2's folder card: the count of files still
    // needing data is red inside the folder (.pl-folder .miss), not a chip.
    expect(dash).toContain('className="miss"');
    // the headline counter, but only while something is actually outstanding
    expect(dash).toContain("totals.incomplete > 0 ? ' is-danger' : ''");
  });

  it('the customer form marks the missing-parts chip red', () => {
    const form = readFileSync(
      join(process.cwd(), 'components/collections/CustomerForm.tsx'),
      'utf8'
    );
    expect(form).toContain('dash-chip dash-chip-danger');
  });
});
