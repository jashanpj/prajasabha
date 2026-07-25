import { describe, expect, it } from "vitest";

// AC2: pnpm workspace resolves and builds across all packages.
//
// This proves the workspace link is real (not just structurally claimed):
// apps/web imports packages/shared's main export via the workspace package
// name "shared" (see tests/scaffold/packages-exist.test.ts for the naming
// convention) and asserts the value round-trips correctly.
//
// Implementation must export, from packages/shared/src/index.ts:
//   export const APP_NAME = "PrajaSabha";
//
// Until packages/shared exists and is linked into apps/web's
// node_modules by pnpm, this import fails to resolve.

describe("AC2: workspace resolution across packages", () => {
  it("resolves and imports APP_NAME from the shared package", async () => {
    const { APP_NAME } = await import("shared");
    expect(APP_NAME).toBe("PrajaSabha");
  });
});
