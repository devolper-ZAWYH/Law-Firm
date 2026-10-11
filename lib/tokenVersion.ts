/**
 * Edge-safe read of a user's current `token_version` for session revocation (F2).
 *
 * Uses a raw `fetch` to the Supabase REST (PostgREST) endpoint so it can run in
 * BOTH the Edge middleware and Node route handlers/Server Components. It reads
 * the service-role key from the server environment — this module is only ever
 * imported by server/edge code (middleware, lib/session.ts), never by a Client
 * Component, so the key never reaches the browser bundle.
 *
 * FAIL-OPEN by design: any error, missing column, or missing row returns `null`,
 * which callers treat as "cannot determine → do not revoke". This guarantees a
 * transient DB blip (or a not-yet-run migration) can never lock out valid users
 * or break login. Revocation only triggers on a *definitive* version mismatch.
 */
export async function fetchTokenVersion(
  userId: string
): Promise<number | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !userId) return null;

  try {
    const res = await fetch(
      `${url}/rest/v1/app_users?id=eq.${encodeURIComponent(
        userId
      )}&select=token_version`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        /*
          BOUNDED, because this runs in middleware on every authenticated page
          navigation — and it runs BEFORE the isProtected check, so /login pays
          it too. An unbounded hang here does not just slow one page: it holds
          the edge open for every navigation at once.

          Two seconds, tighter than the Supabase client's ten, because this is a
          single indexed row read on the critical path of every request. If it
          cannot answer in two seconds the answer is not worth waiting for.

          An abort lands in the catch below and returns null — which this
          function already defines as "do not revoke". That fail-open is the
          documented, deliberate behaviour: a revocation check that cannot run
          must not sign the whole firm out. Timing out simply reaches it
          promptly instead of never.
        */
        signal: AbortSignal.timeout(2_000),
      }
    );
    if (!res.ok) return null; // e.g. 400 if the column doesn't exist yet
    const rows = (await res.json()) as Array<{ token_version?: unknown }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const v = rows[0]?.token_version;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}
