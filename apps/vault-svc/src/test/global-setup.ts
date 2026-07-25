import { runMigrations } from "vault-db";

// Applies packages/vault-db's migrations once before any test file runs,
// using the superuser VAULT_DATABASE_URL (migrations need to CREATE ROLE).
// Runtime route tests connect as vault_role via VAULT_SVC_DATABASE_URL
// instead — see index.test.ts.
export async function setup(): Promise<void> {
  const vaultDatabaseUrl = process.env.VAULT_DATABASE_URL;
  if (!vaultDatabaseUrl) {
    throw new Error(
      "VAULT_DATABASE_URL is not set. apps/vault-svc tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  await runMigrations(vaultDatabaseUrl);
}
