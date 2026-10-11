import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TREE,
  expandCapabilities,
  isCapabilityKey,
} from '@/lib/platform/capabilities';
import { FILE_SECTIONS } from '@/lib/platform/fileColors';

/**
 * WHOLESALE FOLDER VISIBILITY IS PER SECTION.
 *
 * "See every folder in the company" is four grants, one per column of the
 * Folders board, so an admin can let someone review closed matters without
 * also opening every live one.
 *
 * The trap these tests exist for: expandCapabilities deliberately expands
 * child → parent as well as parent → child, because routes normally enforce
 * the coarse parent. Under that rule, granting only "…every Expired folder"
 * ALSO implies 'files.viewAll' — so if any code ever enforced the parent, a
 * single-section grant would silently open the whole company. The parent is
 * therefore presentation only, and nothing may enforce it.
 */

const SECTION_KEYS = FILE_SECTIONS.map((s) => `files.viewAll.${s}`);

describe('per-section folder visibility', () => {
  it('defines one capability per folder section, and no more', () => {
    const files = CAPABILITY_TREE.find((g) => g.key === 'files');
    const viewAll = files?.capabilities.find((c) => c.key === 'files.viewAll');
    expect(viewAll).toBeDefined();
    const children = (viewAll?.children ?? []).map((c) => c.key);
    // Exactly the sections the board has — no orphan key, no missing column.
    expect(children.sort()).toEqual([...SECTION_KEYS].sort());
  });

  it('every section key is a real capability key', () => {
    for (const key of SECTION_KEYS) expect(isCapabilityKey(key)).toBe(true);
  });

  /**
   * The old blanket grant still means what it always meant. Existing stored
   * rows say 'files.viewAll' and nothing else; they must keep opening every
   * section rather than quietly becoming a grant of nothing.
   */
  it('a legacy files.viewAll grant still opens every section', () => {
    const granted = expandCapabilities(['files.viewAll']);
    for (const key of SECTION_KEYS) expect(granted.has(key)).toBe(true);
  });

  /**
   * THE POINT OF THE SPLIT. One section must not drag the others in.
   */
  it('granting one section does NOT grant the others', () => {
    const granted = expandCapabilities(['files.viewAll.expired']);
    expect(granted.has('files.viewAll.expired')).toBe(true);
    expect(granted.has('files.viewAll.active')).toBe(false);
    expect(granted.has('files.viewAll.potential')).toBe(false);
    expect(granted.has('files.viewAll.attrition')).toBe(false);
  });

  /**
   * The parent IS implied by a child — that is expandCapabilities working as
   * designed — which is precisely why no route may enforce it. This test pins
   * the hazard so the next person to reach for `hasCapability(g,
   * 'files.viewAll')` sees why it is wrong.
   */
  it('a single section implies the parent, so the parent must never be enforced', () => {
    const granted = expandCapabilities(['files.viewAll.expired']);
    expect(granted.has('files.viewAll')).toBe(true);
  });

  it('holding all four sections is equivalent to the blanket grant', () => {
    const all = expandCapabilities(SECTION_KEYS);
    const blanket = expandCapabilities(['files.viewAll']);
    for (const key of SECTION_KEYS) {
      expect(all.has(key)).toBe(blanket.has(key));
    }
  });

  it('an employee with no grant sees no section wholesale', () => {
    const granted = expandCapabilities([]);
    for (const key of SECTION_KEYS) expect(granted.has(key)).toBe(false);
  });

  /**
   * A neighbouring grant in the same group must not leak visibility: being
   * allowed to EDIT a folder says nothing about which folders you may see.
   */
  it('an unrelated files grant confers no wholesale visibility', () => {
    const granted = expandCapabilities(['files.edit', 'files.create']);
    for (const key of SECTION_KEYS) expect(granted.has(key)).toBe(false);
  });
});

/**
 * The server must ask about the four leaves and never the parent. Enforced by
 * reading the source, because the failure is silent: enforcing the parent
 * still compiles, still passes every other test, and hands one-section
 * employees the whole company.
 */
describe('no route enforces the presentation parent', () => {
  it("never asks for the bare 'files.viewAll'", async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === '.next') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        // The definition and this test are allowed to name it.
        if (full.includes('capabilities.ts')) continue;
        if (full.includes('file-visibility-per-section')) continue;
        const src = readFileSync(full, 'utf8');
        // A quoted 'files.viewAll' NOT followed by a section suffix.
        if (/['"`]files\.viewAll['"`]/.test(src)) offenders.push(full);
      }
    };
    walk(join(process.cwd(), 'app'));
    walk(join(process.cwd(), 'lib'));
    walk(join(process.cwd(), 'components'));
    expect(offenders).toEqual([]);
  });
});
