import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — can this deployment actually reach its database?
 *
 * WHY IT IS UNAUTHENTICATED. Every other way of answering that question needs a
 * working database: signing in is itself a database read, so when the database
 * is unreachable there is no way to authenticate in order to ask why. A health
 * check that requires the thing it is checking is useless exactly when it is
 * needed.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. No URLs, no hostnames, no keys, no
 * connection strings — only whether each variable is PRESENT, a coarse
 * classification of the database host, and a redacted error. Anything that
 * could identify or address the project is stripped by redact() below, so this
 * endpoint cannot become a way to discover infrastructure.
 */

/** Remove anything that could address or identify the project. */
function redact(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[a-z0-9]{15,}\.supabase\.(co|com|net)/gi, '<host>')
    .replace(/[a-z0-9]{15,}\.pooler\.supabase\.com/gi, '<host>')
    // Any long opaque token (a service-role JWT, a password) never leaves here.
    .replace(/[A-Za-z0-9_\-]{40,}/g, '<redacted>')
    .slice(0, 300);
}

/**
 * Which kind of Postgres host DATABASE_URL points at — the single most useful
 * fact about a Supabase deployment that cannot migrate. Supabase removed IPv4
 * from `db.<ref>.supabase.co`; a host-only IPv6 address is unreachable from an
 * IPv4-only platform, and the pooler host is the IPv4 route.
 */
function classifyDatabaseUrl(raw: string | undefined): string {
  if (!raw) return 'absent';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    return 'unparseable';
  }
  if (/^db\..*\.supabase\.co$/i.test(host)) return 'supabase-direct (IPv6-only)';
  if (/pooler\.supabase\.com$/i.test(host)) return 'supabase-pooler (IPv4)';
  return 'other';
}

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const report: Record<string, unknown> = {
    supabaseUrlSet: Boolean(supabaseUrl),
    serviceKeySet: Boolean(serviceKey),
    authSecretSet: Boolean(process.env.AUTH_SECRET),
    databaseUrl: classifyDatabaseUrl(process.env.DATABASE_URL),
  };

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { ok: false, stage: 'config', ...report },
      { status: 200 }
    );
  }

  // A trivial REST round trip, on the same path login takes. Bounded so this
  // endpoint answers promptly instead of hanging the way login does.
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/app_users?select=id&limit=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const elapsedMs = Date.now() - started;
    const body = await res.text();
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        stage: 'reached',
        httpStatus: res.status,
        elapsedMs,
        detail: redact(body),
        ...report,
      });
    }

    // SCHEMA STATE. Which migrations have actually landed in the database this
    // deployment is using — asked of that database directly, so it cannot be
    // confused with whatever a local .env happens to point at.
    //
    // One request now, where there were six. Besides going stale, the old
    // probes made every unauthenticated hit of this endpoint cost seven round
    // trips to the same connection pooler that serves real traffic.
    /*
      ASK THE LEDGER, NOT A HAND-WRITTEN LIST.

      This used to fire six hardcoded column probes for migrations #31 and #32.
      They were accurate the day they were written and have been drifting ever
      since: the repo is now at #40, and the eight PayLater migrations all
      landed after the last probe was added. So the one in-product detector of
      a schema problem could not see the eight most recent schema changes — a
      detector that goes stale is worse than none, because it reports healthy.

      `_migrations` is the ledger `scripts/migrate.ts` writes, and crucially
      NOTHING is recorded there unless it actually committed. Reading the newest
      applied filename and comparing it to the newest file on disk therefore
      answers the real question — "is the database as new as this build?" —
      for every migration, including ones written after this line.

      It cannot go stale, because it names no migration.
    */
    const migrationsRes = await fetch(
      `${supabaseUrl}/rest/v1/_migrations?select=filename&order=filename.desc&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: 'application/json',
          Prefer: 'count=exact',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(4_000),
      }
    ).catch(() => null);

    let appliedCount: number | null = null;
    let newestApplied: string | null = null;
    if (migrationsRes?.ok) {
      // PostgREST returns the true total in Content-Range as `0-0/N`.
      const range = migrationsRes.headers.get('content-range') ?? '';
      const total = Number(range.split('/')[1]);
      appliedCount = Number.isFinite(total) ? total : null;
      const rows = (await migrationsRes
        .json()
        .catch(() => [])) as Array<{ filename?: unknown }>;
      const f = rows[0]?.filename;
      newestApplied = typeof f === 'string' ? f : null;
    }

    return NextResponse.json({
      ok: true,
      stage: 'reached',
      httpStatus: res.status,
      elapsedMs,
      schema: {
        /*
          `newestApplied` is what the database has actually run. Compare it to
          the newest filename in supabase/migrations/ for this build: equal
          means the schema matches the code, and anything older means a
          migration did not apply — the failure that is otherwise silent,
          because migrate.ts exits 0 by design so the site still boots.
        */
        migrationsApplied: appliedCount,
        newestApplied,
        // null when the ledger could not be read at all — which is itself the
        // signal, and deliberately distinct from "read it, found nothing".
        ledgerReadable: appliedCount !== null,
      },
      ...report,
    });
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    return NextResponse.json({
      ok: false,
      stage: 'unreachable',
      elapsedMs,
      errorName: e?.name ?? 'Error',
      errorCode: e?.cause?.code ?? null,
      detail: redact(e?.message ?? String(err)),
      ...report,
    });
  } finally {
    clearTimeout(timer);
  }
}
