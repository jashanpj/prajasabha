import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro"]);
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|require\()\s*["']([^"']+)["']/g;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === "node_modules") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      files.push(fullPath);
    }
  }

  return files;
}

// apps/vault-svc (issue #20) is the sole, deliberate exception: CLAUDE.md
// invariant 2 lists apps/web, apps/api, and apps/jobs by name, not "every
// app" — apps/vault-svc exists specifically to be the only thing that
// imports packages/vault-db, so apps/web etc. never have to. See HLD §4's
// "vault-svc exposes internal operations, called only by apps/web" and
// packages/shared/src/lint/vault-isolation.repo.test.ts's fixture proving
// apps/web/apps/api/apps/jobs are still checked.
const ALLOWED_VAULT_DB_IMPORTERS = new Set(["vault-svc"]);

/**
 * Scans apps/*\/src for any import/require specifier referencing vault-db.
 * Enforces CLAUDE.md invariant 2: packages/vault-db is never imported by
 * apps/web, apps/api, or apps/jobs. Returns an empty array for a clean tree.
 */
export function checkVaultIsolation(rootDir: string): string[] {
  const violations: string[] = [];
  const appsDir = join(rootDir, "apps");

  let appNames: string[];
  try {
    appNames = readdirSync(appsDir);
  } catch {
    return violations;
  }

  for (const appName of appNames) {
    if (ALLOWED_VAULT_DB_IMPORTERS.has(appName)) continue;
    const srcDir = join(appsDir, appName, "src");
    let sourceFiles: string[];
    try {
      sourceFiles = listSourceFiles(srcDir);
    } catch {
      continue;
    }

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, "utf-8");
      for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = match[1];
        if (specifier?.includes("vault-db")) {
          violations.push(
            `${relative(rootDir, filePath)} imports "${specifier}" — packages/vault-db must never be imported from apps/*`,
          );
        }
      }
    }
  }

  return violations;
}
