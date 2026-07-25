import { runMigrations } from "../migrate";

// Vitest globalSetup — runs exactly once before any test file, in its own
// process. Required because vitest runs test files across parallel
// workers; if each file's own beforeAll called runMigrations, two workers
// racing to CREATE SCHEMA "drizzle" (drizzle's migration-tracking table)
// at the same instant produced a duplicate-key error. One-time setup here
// avoids the race entirely.
export async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. RLS/immutability tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  await runMigrations(databaseUrl);
}
