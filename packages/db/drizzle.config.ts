import { defineConfig } from "drizzle-kit";

// No tables yet — the participation-DB schema lands in issue #15. This
// config exists so `drizzle-kit check` (wired into ci.yml) has something
// valid to run against on an empty-but-real skeleton.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
