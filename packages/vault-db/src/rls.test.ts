import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// Real Postgres, real roles — every assertion here is a rejected/accepted
// query against actual RLS policies + GRANTs from
// migrations/0000_init_vault_schema.sql, not an app-level check. Mirrors
// packages/db/src/rls.test.ts's pattern.

let vaultDatabaseUrl: string;
// A throwaway, zero-grant role created/dropped entirely within this test
// file — deliberately NOT reusing packages/db's anon/authenticated/
// service_role roles, since those are created by a different package's
// migration and may or may not have run yet when `vault-db`'s own test
// suite runs standalone (pnpm --filter vault-db test).
const noAccessRole = `vault_rls_test_no_access_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: vaultDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  vaultDatabaseUrl = ensureMigrated();
  await withSuperuser((client) => client.query(`CREATE ROLE "${noAccessRole}" NOLOGIN`));
});

afterAll(async () => {
  await withSuperuser((client) => client.query(`DROP ROLE IF EXISTS "${noAccessRole}"`));
});

describe("vault.auth_credentials RLS", () => {
  it("vault_role can INSERT, SELECT, and UPDATE its own rows", async () => {
    const id = await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO vault.auth_credentials
           (email_hash, email_ciphertext, email_iv, pseudonym, locale, token_hash, expires_at)
         VALUES ($1, 'ciphertext', 'iv', 'Pseudonym', 'ml', 'tokenhash', now() + interval '15 minutes')
         RETURNING id`,
        [`hash-${randomUUID()}`],
      );
      return insertResult.rows[0]?.id;
    });
    expect(id).toBeDefined();

    await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const selectResult = await client.query(
        "SELECT * FROM vault.auth_credentials WHERE id = $1",
        [id],
      );
      expect(selectResult.rows).toHaveLength(1);

      const updateResult = await client.query(
        "UPDATE vault.auth_credentials SET consumed_at = now() WHERE id = $1 RETURNING consumed_at",
        [id],
      );
      expect(updateResult.rows[0]?.consumed_at).toBeTruthy();
    });
  });

  it("a role with no grant on the vault schema cannot SELECT auth_credentials", async () => {
    await withSuperuser(async (client) => {
      await client.query(`SET ROLE "${noAccessRole}"`);
      await expect(client.query("SELECT * FROM vault.auth_credentials LIMIT 1")).rejects.toThrow(
        /permission denied/,
      );
      await client.query("RESET ROLE");
    });
  });

  it("a role with no grant on the vault schema cannot INSERT into auth_credentials", async () => {
    await withSuperuser(async (client) => {
      await client.query(`SET ROLE "${noAccessRole}"`);
      await expect(
        client.query(
          `INSERT INTO vault.auth_credentials
             (email_hash, email_ciphertext, email_iv, pseudonym, locale, token_hash, expires_at)
           VALUES ('x', 'x', 'x', 'x', 'ml', 'x', now())`,
        ),
      ).rejects.toThrow(/permission denied/);
      await client.query("RESET ROLE");
    });
  });
});
