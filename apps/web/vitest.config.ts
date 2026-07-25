import { defineConfig } from "vitest/config";

// NOTE (issue #73): Astro's container API (astro/container) needs test
// files to run inside a Vite instance carrying Astro's own Vite plugins —
// normally wired via `getViteConfig` from "astro/config". That doesn't
// work in this repo yet: astro@6.4.8 requires vite@^7.3.2, but the
// vitest@2.1.x pinned at the workspace root depends on vite@5.x, and
// mixing the two crashes vitest's dev server on startup (Astro's
// vite-plugin-head touches Vite 7's Environment API, absent in Vite 5).
// Fixing this means bumping vitest across the whole monorepo — out of
// scope for a design-token/component PR. Component correctness for #73 is
// instead verified by a real `astro build` (which doesn't hit this
// dev-server-only code path) via the existing Playwright smoke test.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
    // Applies packages/db's + packages/vault-db's migrations once before
    // any test runs — see src/test/global-setup.ts.
    globalSetup: "./src/test/global-setup.ts",
  },
});
