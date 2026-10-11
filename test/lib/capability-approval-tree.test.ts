import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ACTION_BY_CAPABILITY,
  allCapabilityKeys,
  approvableCapabilityKeys,
  expandCapabilities,
  isApprovableCapability,
  isCapabilityKey,
} from '@/lib/platform/capabilities';

describe('the new capability keys', () => {
  it('defines the three actions this work was asked for', () => {
    expect(isCapabilityKey('tasks.delete')).toBe(true);
    expect(isCapabilityKey('files.create')).toBe(true);
    expect(isCapabilityKey('company.contactsAdd')).toBe(true);
  });

  it('does NOT let "see the client directory" imply "add to it"', () => {
    // The two are siblings on purpose. If contactsAdd were nested under
    // company.contacts, every read grant would silently carry write access —
    // the exact mistake the sibling layout exists to prevent.
    const readOnly = expandCapabilities(['company.contacts']);
    expect(readOnly.has('company.contacts')).toBe(true);
    expect(readOnly.has('company.contactsAdd')).toBe(false);
  });

  it('does not let "add to the directory" imply anything else either', () => {
    const addOnly = expandCapabilities(['company.contactsAdd']);
    expect(addOnly.has('company.contactsAdd')).toBe(true);
    expect(addOnly.has('company.contacts')).toBe(false);
  });
});

describe('the approvable set', () => {
  it('only contains keys the tree actually defines', () => {
    // A typo here would be a toggle the UI offers and no route ever honours.
    for (const key of Object.keys(APPROVAL_ACTION_BY_CAPABILITY)) {
      expect(isCapabilityKey(key), `${key} is not in the tree`).toBe(true);
    }
  });

  it('covers the three requested actions', () => {
    expect(isApprovableCapability('tasks.delete')).toBe(true);
    expect(isApprovableCapability('files.create')).toBe(true);
    expect(isApprovableCapability('company.contactsAdd')).toBe(true);
  });

  it('leaves read-only capabilities ungateable', () => {
    // Holding a page load for a human decision is not a thing anyone wants.
    expect(isApprovableCapability('files.viewAll')).toBe(false);
    expect(isApprovableCapability('attendance.viewAll')).toBe(false);
    expect(isApprovableCapability('company.contacts')).toBe(false);
    expect(isApprovableCapability('notifications.overdue')).toBe(false);
  });

  it('is a strict subset of the tree, in tree order', () => {
    const all = allCapabilityKeys();
    const approvable = approvableCapabilityKeys();
    expect(approvable.length).toBeLessThan(all.length);
    expect(approvable).toEqual(all.filter((k) => approvable.includes(k)));
  });
});
