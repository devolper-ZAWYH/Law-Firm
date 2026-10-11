'use client';

import type { ClientFolderTypeRecord } from './ManageFolderTypesModal';

/**
 * The folder-types list, fetched ONCE per page load and shared.
 *
 * It is a global list of half a dozen rows that changes when an admin adds a
 * type — a few times a year. Yet four components each fetched it
 * independently, so opening a folder re-requested it every time, and on a
 * database this far away that is ~750ms spent re-learning that "Case" is still
 * called Case.
 *
 * ONE IN-FLIGHT REQUEST, NOT ONE PER CALLER. The cache holds the *promise*,
 * not just the result, so two components mounting in the same tick share a
 * single request rather than racing to fill the cache twice. Every later
 * caller gets the resolved value with no network at all.
 *
 * Module scope, so it lives as long as the page. A reload refetches, which is
 * the right staleness for a list of this kind — and `invalidateFolderTypes()`
 * clears it the moment someone adds a type, so the new one appears without a
 * reload.
 *
 * A failed fetch is NOT cached: the promise is dropped so the next caller
 * retries rather than inheriting a permanent empty list.
 */
let cached: Promise<ClientFolderTypeRecord[]> | null = null;

export function fetchFolderTypes(): Promise<ClientFolderTypeRecord[]> {
  if (cached) return cached;
  cached = (async () => {
    const res = await fetch('/api/folder-types', { cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      folderTypes?: ClientFolderTypeRecord[];
    };
    if (!res.ok || !data.ok || !Array.isArray(data.folderTypes)) {
      throw new Error('folder types unavailable');
    }
    return data.folderTypes;
  })();
  // Drop a rejected promise so the failure is not remembered for the session.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** Call after adding a folder type so the next read sees it. */
export function invalidateFolderTypes(): void {
  cached = null;
}
