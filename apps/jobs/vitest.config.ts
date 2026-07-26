import { defineConfig } from "vitest/config";

// Same fileParallelism:false + globalSetup pattern as apps/web's
// vitest.config.ts (issue #35 adds this app's first DB-touching tests) —
// see that file's comment for why: every DB test file opens its own
// Postgres connection pool, and parallel file execution exhausts a dev/CI
// Postgres container's connection limit.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: "./src/test/global-setup.ts",
    fileParallelism: false,
  },
});
