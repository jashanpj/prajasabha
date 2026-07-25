import { runMigrations } from "../migrate";

// Vitest globalSetup — runs exactly once before any test file, in its own
// process. Mirrors packages/db/src/test/global-setup.ts: without this,
// parallel test-file workers race to CREATE SCHEMA "drizzle" (drizzle's
// own migration-tracking table) and one loses with a duplicate-key error.
export async function setup(): Promise<void> {
  const vaultDatabaseUrl = process.env.VAULT_DATABASE_URL;
  if (!vaultDatabaseUrl) {
    throw new Error(
      "VAULT_DATABASE_URL is not set. RLS/uniqueness tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  await runMigrations(vaultDatabaseUrl);
}
