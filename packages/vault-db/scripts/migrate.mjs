#!/usr/bin/env node
// Applies packages/vault-db/migrations against process.env.VAULT_DATABASE_URL.
// Plain JS (not importing packages/vault-db/src/migrate.ts) so it runs with
// plain `node`, no TS loader needed — mirrors packages/db/scripts/migrate.mjs.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const vaultDatabaseUrl = process.env.VAULT_DATABASE_URL;
if (!vaultDatabaseUrl) {
  console.error("VAULT_DATABASE_URL is not set — copy .env.example to .env first.");
  process.exit(1);
}

const pool = new Pool({ connectionString: vaultDatabaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
await pool.end();
console.log("Migrations applied.");
