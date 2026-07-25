import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// AC4: packages/vault-db is not importable from apps/web, apps/api, or
// apps/jobs — enforced by schema-guard agent + import check.
//
// This test exercises the import-check half of that enforcement:
// checkVaultIsolation(rootDir) walks a repo root and returns a list of
// violation descriptions for any file under apps/* that imports vault-db.
// An empty array means the tree is clean.
//
// Implementation lives at packages/shared/src/lint/vault-isolation.ts and
// does not exist yet, so this import fails to resolve until it's built.
import { checkVaultIsolation } from "./vault-isolation";

const fixtureDirs: string[] = [];

function makeFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-isolation-fixture-"));
  fixtureDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("AC4: checkVaultIsolation", () => {
  it("flags a file under apps/* that imports vault-db", () => {
    const root = makeFixtureRoot();
    const badFileDir = join(root, "apps", "web", "src");
    mkdirSync(badFileDir, { recursive: true });
    const badFilePath = join(badFileDir, "bad.ts");
    writeFileSync(
      badFilePath,
      `import { x } from "../../../packages/vault-db/src/index";\n\nexport const y = x;\n`,
      "utf-8",
    );

    const violations = checkVaultIsolation(root);

    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.includes("bad.ts"))).toBe(true);
  });

  it("allows apps/vault-svc to import vault-db (the sole deliberate exception, issue #20)", () => {
    const root = makeFixtureRoot();
    const vaultSvcDir = join(root, "apps", "vault-svc", "src");
    mkdirSync(vaultSvcDir, { recursive: true });
    writeFileSync(
      join(vaultSvcDir, "index.ts"),
      `import { createVaultDbClient } from "vault-db";\n\nexport const client = createVaultDbClient;\n`,
      "utf-8",
    );

    expect(checkVaultIsolation(root)).toEqual([]);
  });

  it("still flags apps/web importing vault-db even when apps/vault-svc also exists", () => {
    const root = makeFixtureRoot();
    const vaultSvcDir = join(root, "apps", "vault-svc", "src");
    mkdirSync(vaultSvcDir, { recursive: true });
    writeFileSync(join(vaultSvcDir, "index.ts"), `import { schema } from "vault-db";\n`, "utf-8");

    const webDir = join(root, "apps", "web", "src");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "bad.ts"), `import { schema } from "vault-db";\n`, "utf-8");

    const violations = checkVaultIsolation(root);
    expect(violations.some((v) => v.includes("bad.ts"))).toBe(true);
    expect(violations.some((v) => v.includes("vault-svc"))).toBe(false);
  });

  it("returns no violations for a clean tree with no vault-db references under apps/*", () => {
    const root = makeFixtureRoot();
    const goodFileDir = join(root, "apps", "web", "src");
    mkdirSync(goodFileDir, { recursive: true });
    writeFileSync(
      join(goodFileDir, "good.ts"),
      `import { shared } from "shared";\n\nexport const y = shared;\n`,
      "utf-8",
    );

    const apiFileDir = join(root, "apps", "api", "src");
    mkdirSync(apiFileDir, { recursive: true });
    writeFileSync(
      join(apiFileDir, "handler.ts"),
      `import { db } from "db";\n\nexport const handler = () => db;\n`,
      "utf-8",
    );

    const violations = checkVaultIsolation(root);

    expect(violations).toEqual([]);
  });
});
