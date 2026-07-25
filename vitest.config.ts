import { defineConfig } from "vitest/config";

// Minimal root-level Vitest config so colocated tests under apps/* and
// packages/* (plus top-level tests/*) are discoverable before the
// per-package scaffolding (and their own vitest configs, if any) exists.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
