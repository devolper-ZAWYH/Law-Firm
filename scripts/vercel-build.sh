#!/usr/bin/env bash
# Vercel's build entry point. Vercel is the TESTING environment; production
# deploys from Railway, which migrates at start instead (see README).
#
# TWO THINGS THIS DOES THAT `npm run migrate && next build` DID NOT:
#
# 1. ONLY PRODUCTION BUILDS MIGRATE. Vercel runs the build script for every
#    deployment, including a preview of an unmerged branch. Because the
#    migration was chained into the build, pushing a branch that added a
#    migration applied it to the shared testing database and recorded it in
#    `_migrations` before anyone reviewed it — and since migrations are
#    additive-only by policy, there was no way back. That database holds real
#    client records.
#
# 2. A FAILED MIGRATION FAILS THE BUILD. `scripts/migrate.ts` exits 0 on
#    failure BY DESIGN, so that a bad migration cannot stop the site booting.
#    That trade is right for Railway at start-up; it is wrong here, where
#    nothing is booting yet. MIGRATE_STRICT=1 turns the same script strict, so
#    a broken migration stops a TESTING build instead of shipping quietly and
#    leaving new code running against an old schema.
#
#    Production keeps the boot-first policy untouched.
set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "vercel-build: production — applying migrations (strict)"
  MIGRATE_STRICT=1 npm run migrate
else
  echo "vercel-build: VERCEL_ENV='${VERCEL_ENV:-unset}' — skipping migrations."
  echo "  Preview and branch builds do not touch the shared testing database."
fi

next build
