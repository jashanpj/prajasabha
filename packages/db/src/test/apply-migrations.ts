/**
 * Returns the DATABASE_URL used by RLS/immutability tests. Migrations
 * themselves are applied once via vitest's globalSetup (./global-setup.ts),
 * not per test file — see that file for why (a parallel-worker race on
 * drizzle's own migration-tracking schema).
 */
export function ensureMigrated(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. RLS/immutability tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  return databaseUrl;
}
