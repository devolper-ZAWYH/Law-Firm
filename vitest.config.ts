import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Test runner config.
 *
 * Two resolutions matter here:
 *
 *  • `@/…` — mirrors the `paths` alias in tsconfig.json so tests import modules
 *    exactly the way the app does. Written as a regex (not the bare string '@')
 *    so it cannot also swallow scoped packages like '@supabase/supabase-js'.
 *
 *  • `server-only` — the real package throws on import outside a React Server
 *    Component, which would make every lib/ module untestable. It is swapped for
 *    an empty stub. That is safe because the guarantee it provides (the
 *    service-role key never reaches a client bundle) is a BUILD-time property of
 *    `next build`, and the stub is scoped to the test runner only.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: [
      {
        find: /^server-only$/,
        replacement: path.resolve(__dirname, 'test/stubs/server-only.ts'),
      },
      { find: /^@\//, replacement: path.resolve(__dirname, '.') + '/' },
    ],
  },
});
