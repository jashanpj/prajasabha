/**
 * Returns the VAULT_DATABASE_URL used by RLS/uniqueness tests. Migrations
 * themselves are applied once via vitest's globalSetup (./global-setup.ts),
 * not per test file — see that file for why.
 */
export function ensureMigrated(): string {
  const vaultDatabaseUrl = process.env.VAULT_DATABASE_URL;
  if (!vaultDatabaseUrl) {
    throw new Error(
      "VAULT_DATABASE_URL is not set. RLS/uniqueness tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  return vaultDatabaseUrl;
}
