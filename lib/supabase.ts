import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only Supabase client using the SERVICE ROLE key.
 *
 * The `server-only` import above makes the build fail if this module is ever
 * imported into a Client Component, guaranteeing the service-role key never
 * reaches the browser bundle. RLS is enabled on app_users with no anon
 * policies; the service-role key bypasses RLS for trusted server code.
 */
let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    /*
      EVERY QUERY IS BOUNDED. Without this, no database call in the application
      has a timeout — `fetch` has no default one, so a Supabase degradation that
      is SLOW rather than DOWN parks the request forever. Railway's
      `restartPolicyType: ON_FAILURE` never fires, because nothing failed; the
      process is simply waiting, and on a single instance the waiting requests
      accumulate until it stops answering.

      That is a different failure from the one the code already handles. The
      fail-open in lib/tokenVersion.ts covers a read that ERRORS. It does not
      cover a read that never returns.

      TEN SECONDS, not five. The ceiling has to clear the slowest legitimate
      call, and the slowest one here is /api/paylater/bulk-dates, which updates
      up to 1000 rows in a single request. Ten leaves that room while still
      turning an indefinite hang into a bounded error. Once the app sits beside
      the database in europe-west4 this could come down a long way — but a
      timeout tuned to a fast network is a timeout that fires on a slow day, so
      it stays generous until there are numbers to lower it against.

      An AbortError surfaces as a normal query error, which every caller here
      already handles.
    */
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
  });
  return cached;
}
