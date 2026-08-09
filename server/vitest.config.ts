import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Clears `CONCEPTS_URL`/`CONCEPTS_TOKEN` before any test runs, so an
    // exporting shell cannot have the suite talk to the live Worker.
    setupFiles: ['./test/setup-env.ts'],
  },
});
