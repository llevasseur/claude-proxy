import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The concept reads consult `CONCEPTS_URL`/`CONCEPTS_TOKEN`, so a developer
    // who exports them for `/teach` would otherwise have the suite talk to the
    // live Worker. Cleared before any test runs; the remote tests set their own.
    setupFiles: ['./test/setup-env.ts'],
  },
});
