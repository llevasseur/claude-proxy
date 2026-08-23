import { defineConfig } from 'vitest/config';

// jsdom stays per-file via the `@vitest-environment` pragma; globals are on
// because the shared test scaffolding uses `vi` directly.
export default defineConfig({
  test: {
    globals: true,
  },
});
