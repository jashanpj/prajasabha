import { runMigrations } from "db";

// Vitest globalSetup — applies packages/db's migrations once before any
// apps/web test runs, using the superuser DATABASE_URL (migrations need
// to CREATE ROLE). apps/web's own tests connect as app_role
// (APP_DATABASE_URL) instead — see src/lib/db.ts. Needed because
// `pnpm -r test` doesn't guarantee packages/db's own test suite (which
// applies its migration via its own globalSetup) runs before apps/web's.
//
// Deliberately does NOT touch packages/vault-db here, even though apps/web
// tests do exercise VAULT_SVC-shaped calls — those are always a mocked
// Fetcher in tests (never a real vault-svc connection), and importing
// "vault-db" from apps/web (even just in a test file) would violate
// CLAUDE.md invariant 2 / packages/shared's checkVaultIsolation, which
// scans this app's entire src/ tree, tests included.
export async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. apps/web tests need a real Postgres (docker compose up -d, " +
        "then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  await runMigrations(databaseUrl);
}
