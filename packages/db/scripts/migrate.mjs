#!/usr/bin/env node
// Applies packages/db/migrations against process.env.DATABASE_URL. Plain JS
// (not importing packages/db/src/migrate.ts) so it runs with plain `node`,
// no TS loader needed — mirrors scripts/check-i18n-parity.mjs's approach at
// the repo root. Local-dev/test convenience only, no safety rails: see
// src/migrate.ts's docstring for why this must never target staging/prod.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set — copy .env.example to .env first.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
await pool.end();
console.log("Migrations applied.");
