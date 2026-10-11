/**
 * "Is this error just a migration that hasn't been applied here yet?"
 *
 * WHY THIS EXISTS. New code is deployed BEFORE its migration runs — that is
 * the normal state of every deploy, for at least a few seconds, and for longer
 * if the migration step is failing (it no longer blocks the boot; see
 * scripts/migrate.ts). So any read or write touching a newly-added table or
 * column has to decide what to do when it is not there yet, and the right
 * answer is almost always "behave as the app did before that column existed"
 * rather than "500".
 *
 * TWO ERROR VOCABULARIES, and both are needed:
 *   • 42P01 / 42703 — the raw Postgres SQLSTATE for an undefined table/column,
 *     returned when the statement actually reaches the database.
 *   • PGRST205 / PGRST204 — PostgREST resolves names against a CACHED schema
 *     first, so a table or column it has never seen is rejected before any SQL
 *     runs, with no SQLSTATE at all.
 *
 * Checking only the Postgres codes misses the common case. That mistake shipped
 * once already and would have 500'd the approvals inbox for the whole window
 * between deploy and migration.
 *
 * Kept deliberately narrow: this must NEVER swallow a real failure (a dropped
 * connection, a permissions problem), because that would turn a genuine outage
 * into silently wrong data.
 */
export function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204'
  );
}
