import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDbClient } from "./index";

/**
 * Applies packages/db/migrations against databaseUrl. Local-dev and test
 * convenience only — it has no manual-approval gate or dry-run, so it must
 * never be pointed at staging/prod (those are applied by a gated CI job
 * ahead of the corresponding Worker deploy, per HLD §8). Used by
 * scripts/migrate.mjs (the `pnpm --filter db run migrate` CLI),
 * src/test/apply-migrations.ts (RLS/immutability test setup), and
 * apps/web's own test global-setup (a different package, different cwd)
 * — migrationsFolder is resolved relative to this file's own location,
 * not process.cwd(), so it works correctly regardless of which package's
 * test runner invoked it.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const db = createDbClient(databaseUrl);
  const migrationsFolder = new URL("../migrations", import.meta.url).pathname;
  await migrate(db, { migrationsFolder });
}
