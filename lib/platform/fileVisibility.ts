import 'server-only';
import {
  FILE_SECTIONS,
  SECTIONS_HIDDEN_FROM_EMPLOYEES,
  type FileSection,
} from './fileColors';
import { getExpandedCapabilities } from './capabilityGrants';

/**
 * Which folder sections may this employee see WHOLESALE — every folder in the
 * section, whether or not it is theirs.
 *
 * "See every folder in the company" is four permissions, one per column of the
 * Folders board, so an admin can let someone review closed matters without
 * also opening every live one. See the note in lib/platform/capabilities.ts
 * for why the server asks about the four leaves and never their parent.
 *
 * Returns [] for the ordinary employee, which is the whole point: no section
 * is visible wholesale, and they see exactly what is granted or assigned to
 * them. Managers and admins never come through here — they read the company
 * list directly.
 */
export async function wholesaleVisibleSections(
  userId: string,
  companyId: string
): Promise<FileSection[]> {
  const granted = await getExpandedCapabilities(userId, companyId);
  return FILE_SECTIONS.filter(
    (s) =>
      granted.has(`files.viewAll.${s}`) &&
      // Expired and Attrition are not an employee's to see, whatever was
      // granted — see SECTIONS_HIDDEN_FROM_EMPLOYEES. The grant is left in
      // place and simply admits nobody while the folder sits in one of those
      // two columns.
      !SECTIONS_HIDDEN_FROM_EMPLOYEES.includes(s)
  );
}
