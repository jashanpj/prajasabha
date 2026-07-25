import { Client } from "pg";

/**
 * Runs `fn` against a dedicated connection with `SET ROLE vault_role`
 * active — mirrors packages/db/src/test/with-role.ts's pattern exactly.
 * Deliberately a single-purpose pg.Client, not a pooled connection: SET
 * ROLE is session-scoped and a pooled connection could leak an elevated
 * role to whichever query runs next on that same socket.
 */
export async function withRole<T>(
  vaultDatabaseUrl: string,
  role: "vault_role",
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: vaultDatabaseUrl });
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await fn(client);
  } finally {
    await client.query("RESET ROLE").catch(() => {});
    await client.end();
  }
}
