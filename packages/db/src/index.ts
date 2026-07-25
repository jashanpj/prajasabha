import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Connection is lazy — constructing a client does not touch the network.
// DATABASE_URL comes from env only (Wrangler secret / CI service binding),
// never hardcoded, per CLAUDE.md invariant 6.
export function createDbClient(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export { schema };
