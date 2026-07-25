import { defineConfig } from "drizzle-kit";

// Separate Drizzle project for the identity vault — a distinct Supabase
// project/credential set from packages/db (see CLAUDE.md's vault join
// rule). No tables yet; real vault schema lands in issue #16. Not wired
// into ci.yml (that only runs `drizzle-kit check` against packages/db) —
// vault-svc's own migration gate is part of #16.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.VAULT_DATABASE_URL ?? "",
  },
});
