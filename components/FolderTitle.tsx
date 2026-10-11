'use client';

import { useDash } from './DashboardShell';

/**
 * A folder's CLIENT vs OPPONENT title rendered as THREE centered, stacked lines:
 *
 *   client
 *   vs          ← red connector, smaller/lighter than the names
 *   opponent
 *
 * Shared by the Folders grid cards, the folder DETAIL header, and the employee
 * "My Files" view so the layout is identical everywhere.
 *
 * TYPE-DRIVEN: a CONTRACT folder has no adversary, so it renders the CLIENT LINE
 * ALONE — even if a stray opponent value were still stored on it. Only a CASE
 * folder can show the "vs" stack.
 *
 * FALLBACK: when a CASE folder has NO opponent, ONLY the client line is shown —
 * the "vs" line and the (empty) opponent line are both omitted.
 *
 * The client/opponent strings are passed in ALREADY resolved to the current
 * language by the caller (same as before). This component sets only the LAYOUT
 * and the "vs" color; the NAME size/weight/color are INHERITED from the wrapping
 * title class (.file-folder-title / .file-detail-title / .dash-section-header),
 * so each context keeps its own scale. The stack order (client → vs → opponent)
 * is the SAME in LTR and RTL.
 */
export default function FolderTitle({
  client,
  opponent,
  folderType = 'case',
  oneLine = false,
}: {
  client: string;
  opponent: string;
  /** Omitted → 'case' (the legacy behaviour for every pre-existing folder). */
  folderType?: 'case' | 'contract';
  /**
   * ONE-LINE variant (Kanban card only): renders "client vs opponent" on a
   * single horizontal line that truncates with an ellipsis when too long. The
   * default (false) keeps the stacked three-line layout used everywhere else
   * (grid cards, list, folder detail header, employee My Files).
   */
  oneLine?: boolean;
}) {
  const { t } = useDash();
  const opp = folderType === 'contract' ? '' : (opponent ?? '').trim();

  // Single horizontal line; the whole line ellipsis-truncates, "vs" stays red.
  if (oneLine) {
    return (
      <span className="folder-title-oneline">
        {client}
        {opp && (
          <>
            {' '}
            <span className="folder-title-vs">{t.versus}</span> {opp}
          </>
        )}
      </span>
    );
  }

  return (
    <span className="folder-title">
      <span className="folder-title-name">{client}</span>
      {opp && (
        <>
          <span className="folder-title-vs">{t.versus}</span>
          <span className="folder-title-name">{opp}</span>
        </>
      )}
    </span>
  );
}
