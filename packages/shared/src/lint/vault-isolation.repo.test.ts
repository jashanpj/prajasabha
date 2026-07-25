import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVaultIsolation } from "./vault-isolation";

// Runs the checker against the real repo, not just fixtures — this is the
// half of AC4 that's actual ongoing enforcement (the other half is the
// schema-guard subagent), wired into `pnpm -r test` since it's colocated.
describe("AC4: checkVaultIsolation against the real repo", () => {
  it("finds zero violations under apps/*", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    expect(checkVaultIsolation(repoRoot)).toEqual([]);
  });
});
