import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Applies packages/vault-db's migrations once before any test file
    // runs — see src/test/global-setup.ts.
    globalSetup: "./src/test/global-setup.ts",
    // Same fix as apps/web/vitest.config.ts: every test file here opens
    // its own Postgres connection pool, and running `pnpm -r test` means
    // this package's file-level parallelism stacks on top of other
    // packages' concurrent connections too — serial execution keeps the
    // total connection count deterministic instead of racing the CI
    // Postgres container's connection limit.
    fileParallelism: false,
  },
});
