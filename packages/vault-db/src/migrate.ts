import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createVaultDbClient } from "./index";

/**
 * Applies packages/vault-db/migrations against vaultDatabaseUrl.
 * Local-dev and test convenience only — no manual-approval gate or dry-run,
 * must never be pointed at staging/prod. Used by scripts/migrate.mjs (the
 * `pnpm --filter vault-db run migrate` CLI), by
 * src/test/apply-migrations.ts (RLS/uniqueness test setup), and by
 * apps/vault-svc's own test global-setup (a different package, different
 * cwd) — migrationsFolder is resolved relative to this file's own location,
 * not process.cwd(), so it works correctly regardless of which package's
 * test runner invoked it.
 *
 * Uses a DEDICATED migrations-tracking schema ("drizzle_vault_db", not
 * drizzle's default "drizzle") — this and packages/db point at the same
 * physical Postgres instance in local dev/CI (Phase 0's docker-compose
 * design), and drizzle's migrator decides "already applied" by comparing
 * each migration's folder timestamp against the LATEST row in the shared
 * tracking table, not per-migration hashes — sharing one tracking table
 * across two logically separate Drizzle projects caused vault-db's own
 * migration to be silently skipped as "already applied" whenever
 * packages/db's migrations recorded a later timestamp. A dedicated
 * tracking table closes this for good, not just for the current
 * timestamp ordering.
 */
export async function runMigrations(vaultDatabaseUrl: string): Promise<void> {
  const db = createVaultDbClient(vaultDatabaseUrl);
  const migrationsFolder = new URL("../migrations", import.meta.url).pathname;
  await migrate(db, { migrationsFolder, migrationsSchema: "drizzle_vault_db" });
}
