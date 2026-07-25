import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// AC1: All six apps/packages exist with minimal working entrypoints.
//
// Each package.json's "name" field must exactly equal the directory's
// basename, unscoped (e.g. "db", not "@prajasabha/db"). This is required
// by .github/workflows/ci.yml, which already hard-codes
// `pnpm --filter db exec drizzle-kit check` — an `@prajasabha/db` scoped
// name would not resolve for that filter without editing the workflow.
//
// Lives in packages/shared (not a standalone tests/ dir) so `pnpm -r test`
// — the actual ci.yml step — exercises it; a root-level test directory
// outside every workspace package is invisible to that recursive command.

const repoRoot = resolve(__dirname, "../../../..");

const expectedPackages: Array<{ dir: string; name: string }> = [
  { dir: "apps/web", name: "web" },
  { dir: "apps/api", name: "api" },
  { dir: "apps/jobs", name: "jobs" },
  { dir: "packages/db", name: "db" },
  { dir: "packages/vault-db", name: "vault-db" },
  { dir: "packages/shared", name: "shared" },
];

describe("AC1: workspace packages exist with correct package.json name", () => {
  for (const { dir, name } of expectedPackages) {
    it(`${dir}/package.json exists and has name "${name}"`, () => {
      const pkgPath = resolve(repoRoot, dir, "package.json");
      expect(existsSync(pkgPath), `Expected ${pkgPath} to exist`).toBe(true);

      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBe(name);
    });
  }
});
