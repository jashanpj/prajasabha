import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Applies packages/vault-db's migrations once before any test file
    // runs — see src/test/global-setup.ts.
    globalSetup: "./src/test/global-setup.ts",
  },
});
