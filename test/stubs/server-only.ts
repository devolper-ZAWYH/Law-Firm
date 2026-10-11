/**
 * Test-only stand-in for the `server-only` package, wired up in
 * vitest.config.ts. The real package throws when imported outside a React
 * Server Component, which would make every module under lib/ impossible to
 * unit-test. Importing this stub is a no-op.
 */
export {};
