import { Client } from "pg";

/**
 * Runs `fn` against a dedicated connection with `SET ROLE <role>` active,
 * so tests exercise the exact same role-scoped permission checks Postgres
 * applies to real anon/authenticated/service_role connections. Deliberately
 * uses a single-purpose `pg.Client`, not the pooled connection `createDbClient`
 * hands out — SET ROLE is session-scoped, and a pooled connection could
 * leak an elevated role to whichever query runs next on that same socket.
 */
export async function withRole<T>(
  databaseUrl: string,
  role: "anon" | "authenticated" | "service_role",
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await fn(client);
  } finally {
    await client.query("RESET ROLE").catch(() => {});
    await client.end();
  }
}
