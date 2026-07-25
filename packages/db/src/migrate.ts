import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDbClient } from "./index";

/**
 * Applies packages/db/migrations against databaseUrl. Local-dev and test
 * convenience only — it has no manual-approval gate or dry-run, so it must
 * never be pointed at staging/prod (those are applied by a gated CI job
 * ahead of the corresponding Worker deploy, per HLD §8). Used by
 * scripts/migrate.mjs (the `pnpm --filter db run migrate` CLI) and by
 * src/test/apply-migrations.ts (RLS/immutability test setup).
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const db = createDbClient(databaseUrl);
  await migrate(db, { migrationsFolder: "./migrations" });
}
