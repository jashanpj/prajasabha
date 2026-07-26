import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Applies migrations once before any test file runs — see
    // src/test/global-setup.ts for why this can't be per-file beforeAll.
    globalSetup: "./src/test/global-setup.ts",
  },
});
