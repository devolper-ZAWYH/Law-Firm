import { describe, expect, it } from 'vitest';
import { expandCapabilities, hasCapability } from '@/lib/platform/capabilities';

/**
 * Server enforcement only ever checks the COARSE parent key (no route
 * enforces an individual leaf sub-permission on its own — see
 * app/api/tasks/[id]/route.ts checking 'tasks.edit', never
 * 'tasks.edit.details'). Checking ONLY a child box in the Permissions UI
 * (e.g. "Reassign to someone else" without its parent "Edit a task") must
 * still satisfy the parent, or that grant silently does nothing — this is
 * the gap behind the "granted a permission but still Forbidden" family of
 * bugs.
 */
describe('expandCapabilities — child grant satisfies its parent', () => {
  it('a leaf-only grant expands to include every ancestor', () => {
    const expanded = expandCapabilities(['tasks.edit.reassign']);
    expect(expanded.has('tasks.edit.reassign')).toBe(true);
    expect(expanded.has('tasks.edit')).toBe(true);
  });

  it('hasCapability("tasks.edit") is satisfied by a child-only grant', () => {
    expect(hasCapability(['tasks.edit.details'], 'tasks.edit')).toBe(true);
  });

  it('still expands parent → children (pre-existing direction, unchanged)', () => {
    const expanded = expandCapabilities(['files.edit']);
    expect(expanded.has('files.edit.client')).toBe(true);
    expect(expanded.has('files.edit.driveLink')).toBe(true);
  });

  it('a grandchild grant satisfies its grandparent too', () => {
    // attendance.upload.mark is a child of attendance.upload.
    const expanded = expandCapabilities(['attendance.upload.mark']);
    expect(expanded.has('attendance.upload')).toBe(true);
  });

  it('an unrelated leaf grant does NOT satisfy a different parent', () => {
    expect(hasCapability(['files.edit.client'], 'tasks.edit')).toBe(false);
  });
});
