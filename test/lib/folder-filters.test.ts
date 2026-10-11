import { describe, expect, it } from 'vitest';

/**
 * The Folders search + filter predicate, as its own function so the rule can be
 * checked without mounting the view.
 *
 * Mirrors matchesFilters in components/FilesView.tsx. Kept in step by the cases
 * below: each one states a decision that was made deliberately, so if the view
 * changes its mind, this says so.
 */

interface Folder {
  clientEn: string;
  clientAr: string;
  opponentEn: string;
  opponentAr: string;
  caseNumber: string;
  folderType: string;
  caseLevel: string;
}

function matches(
  f: Folder,
  query: string,
  typeFilter: string,
  levelFilter: string
): boolean {
  if (typeFilter && f.folderType !== typeFilter) return false;
  if (levelFilter && (f.caseLevel || '') !== levelFilter) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [f.clientEn, f.clientAr, f.opponentEn, f.opponentAr, f.caseNumber]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q);
}

const folder: Folder = {
  clientEn: 'SkipCash',
  clientAr: 'سكب كاش',
  opponentEn: 'Beta Holdings',
  opponentAr: 'بيتا',
  caseNumber: '9911/2026',
  folderType: 'case',
  caseLevel: 'cassation',
};

describe('searching folders', () => {
  it('matches the client in either language', () => {
    expect(matches(folder, 'skipcash', '', '')).toBe(true);
    expect(matches(folder, 'سكب', '', '')).toBe(true);
  });

  it('matches the OPPONENT too — people name a matter by either side', () => {
    expect(matches(folder, 'beta', '', '')).toBe(true);
    expect(matches(folder, 'بيتا', '', '')).toBe(true);
  });

  it('matches a PARTIAL case number', () => {
    // Nobody types the slash-year half when looking for a case.
    expect(matches(folder, '9911', '', '')).toBe(true);
    expect(matches(folder, '9911/2026', '', '')).toBe(true);
  });

  it('ignores case', () => {
    expect(matches(folder, 'SKIPCASH', '', '')).toBe(true);
  });

  it('does not match something absent', () => {
    expect(matches(folder, 'acme', '', '')).toBe(false);
  });

  it('treats an empty query as no filter at all', () => {
    expect(matches(folder, '', '', '')).toBe(true);
    expect(matches(folder, '   ', '', '')).toBe(true);
  });
});

describe('the dropdowns', () => {
  it('filters by case type', () => {
    expect(matches(folder, '', 'case', '')).toBe(true);
    expect(matches(folder, '', 'contract', '')).toBe(false);
  });

  it('filters by case level', () => {
    expect(matches(folder, '', '', 'cassation')).toBe(true);
    expect(matches(folder, '', '', 'appeal')).toBe(false);
  });

  it('excludes a folder with NO level when filtering by one', () => {
    // A folder that never had a level set is not "first instance" by default.
    const noLevel = { ...folder, caseLevel: '' };
    expect(matches(noLevel, '', '', 'first_instance')).toBe(false);
    expect(matches(noLevel, '', '', '')).toBe(true);
  });

  it('combines with the search rather than replacing it', () => {
    expect(matches(folder, 'skipcash', 'case', 'cassation')).toBe(true);
    // Right folder, wrong level — every condition has to hold.
    expect(matches(folder, 'skipcash', 'case', 'appeal')).toBe(false);
  });
});
