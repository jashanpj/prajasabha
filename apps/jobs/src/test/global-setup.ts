import { runMigrations } from "db";

// Vitest globalSetup — applies packages/db's migrations once before any
// apps/jobs test runs, using the superuser DATABASE_URL (migrations need to
// CREATE ROLE). apps/jobs' own tests connect as app_role (APP_DATABASE_URL)
// instead, same as apps/web — see apps/web/src/test/global-setup.ts, which
// this mirrors exactly (`pnpm -r test` doesn't guarantee packages/db's own
// migration-applying test suite runs before this one).
export async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. apps/jobs tests need a real Postgres (docker compose up -d, " +
        "then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  await runMigrations(databaseUrl);
}
