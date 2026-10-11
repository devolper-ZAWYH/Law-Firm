#!/usr/bin/env bash
#
# Serve the built app locally against the TESTING database.
#
# WHY THIS EXISTS. `next start` runs in production mode, and Next only loads
# .env.development.local in DEVELOPMENT — in production mode it reads
# .env.local, which on this machine holds the PRODUCTION Supabase credentials.
# Running `npm run start` directly would therefore point a local server at the
# live firm database without saying so.
#
# Real environment variables beat every .env file, so exporting the testing
# values here makes the target explicit and unmistakable. The script refuses to
# start if they do not look like the testing project.
#
# Usage:  ./scripts/start-local.sh [port]     (default 3000)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.development.local ]; then
  echo "error: .env.development.local not found (it holds the testing credentials)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.development.local
set +a

# Fail loudly rather than silently serving production data.
case "${SUPABASE_URL:-}" in
  *juniddclwnprbxszzfqv*) : ;;
  *)
    echo "REFUSING TO START: SUPABASE_URL is not the testing project." >&2
    echo "  got: ${SUPABASE_URL:-<unset>}" >&2
    exit 1
    ;;
esac
case "${DATABASE_URL:-}" in
  *juniddclwnprbxszzfqv*|*ap-south-1*) : ;;
  *)
    echo "REFUSING TO START: DATABASE_URL is not the testing database." >&2
    exit 1
    ;;
esac

export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY DATABASE_URL AUTH_SECRET
export PORT="${1:-3000}"
export TRUSTED_PROXY_HOPS=0   # no proxy in front of a local server

echo "Serving on http://localhost:${PORT}"
echo "  database : TESTING (juniddclwnprbxszzfqv)"
echo "  data     : a copy of production, with all passwords reset"
exec npx next start -p "${PORT}"
