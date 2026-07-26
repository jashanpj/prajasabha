import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Connection is lazy — constructing a client does not touch the network.
// VAULT_DATABASE_URL comes from env only (Wrangler secret / dual-control
// key split per HLD §4.1), never hardcoded, per CLAUDE.md invariant 6.
export function createVaultDbClient(vaultDatabaseUrl: string) {
  const pool = new Pool({ connectionString: vaultDatabaseUrl });
  return drizzle(pool, { schema });
}

export { schema };
export {
  decryptDoc,
  decryptEmail,
  decryptEpicNumber,
  encryptDoc,
  encryptEmail,
  encryptEpicNumber,
  hashEmail,
  hashEpicNumber,
  normalizeEmail,
  normalizeEpicNumber,
} from "./crypto";
export { runMigrations } from "./migrate";
