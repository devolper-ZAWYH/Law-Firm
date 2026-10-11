// File-status color palette + section→color mapping.
//
// CLIENT-SAFE (no `server-only`): imported by both the server data layer and
// the browser UI. Do NOT add server-only logic or secrets here.
//
// The real color of a file is DERIVED from its tasks by the color engine
// (Phase 5). Until tasks exist, the UI shows the SECTION's static starting
// color as a placeholder (spec §5.1):
//   • potential → light gray
//   • active    → yellow
//   • expired   → green
//   • attrition → dark gray (client left / contract terminated early —
//     terminal, like expired, but a loss rather than a clean close)
//
// The full six-step palette is defined now so later phases (the color engine)
// can reuse it without redefining hex values.

export type FileSection = 'potential' | 'active' | 'expired' | 'attrition';

/**
 * The two TERMINAL sections, hidden from employees entirely.
 *
 * Expired is a closed matter and Attrition is a lost client. Neither is work
 * anybody is still doing, and both carry the history of a relationship that
 * ended — so they are for the manager and the admin, and an employee does not
 * see them at all.
 *
 * "At all" is stronger than the capability tree's wholesale visibility, and it
 * deliberately overrules it: an employee is not shown these folders even when
 * they hold an access grant on one, are the assignee of a task on one, or were
 * granted 'files.viewAll.expired'. The grants are not revoked — a key is
 * permanent, and a folder MOVED into Expired must not silently strip the
 * record of who had it — they simply stop admitting anyone to these two
 * columns while the folder sits there.
 *
 * Enforced server-side in lib/platform/fileVisibility.ts and in
 * listFilesForEmployee; the Folders tabs read it too, so an employee is not
 * offered a column that would come back empty.
 */
export const SECTIONS_HIDDEN_FROM_EMPLOYEES: readonly FileSection[] = [
  'expired',
  'attrition',
];

/** Sections an EMPLOYEE may see. Managers and admins see all four. */
export function sectionsVisibleToEmployees(): FileSection[] {
  return FILE_SECTIONS.filter((s) => !SECTIONS_HIDDEN_FROM_EMPLOYEES.includes(s));
}

export const FILE_SECTIONS: readonly FileSection[] = [
  'potential',
  'active',
  'expired',
  'attrition',
] as const;

/** The six file-status colors (light→red), keyed by name. */
export const FILE_STATUS_PALETTE = {
  lgray: '#C9C6C0', // light gray  — new potential
  dgray: '#8A857D', // dark gray   — (color engine, later)
  yellow: '#D9B23F', // yellow     — new active
  orange: '#D07B34', // orange     — (color engine, later)
  green: '#5E8C70', // green       — expired / resolved
  red: '#C24A3C', // red          — (color engine, later)
} as const;

export type FileStatusColorName = keyof typeof FILE_STATUS_PALETTE;

/**
 * The static placeholder color for a section, used until the color engine
 * (Phase 5) derives the real color from a file's tasks.
 */
export const SECTION_START_COLOR: Record<FileSection, string> = {
  potential: FILE_STATUS_PALETTE.lgray,
  active: FILE_STATUS_PALETTE.yellow,
  expired: FILE_STATUS_PALETTE.green,
  attrition: FILE_STATUS_PALETTE.dgray,
};

/** Type guard: is the given string one of the four file sections? */
export function isFileSection(value: unknown): value is FileSection {
  return (
    value === 'potential' ||
    value === 'active' ||
    value === 'expired' ||
    value === 'attrition'
  );
}
