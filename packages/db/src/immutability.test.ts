import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// CLAUDE.md invariant 3: event_log and moderation_actions are append-only —
// no UPDATE/DELETE anywhere, enforced by REVOKE at the DB level (migration
// 0000). These tests prove the REVOKE is real: service_role can INSERT/
// SELECT but a real Postgres permission error blocks UPDATE and DELETE,
// even though service_role otherwise has full CRUD on every other table.

let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await ensureMigrated();
});

describe.each(["event_log", "moderation_actions"] as const)("%s (append-only)", (table) => {
  const insertRow =
    table === "event_log"
      ? "INSERT INTO event_log (kind, subject_type, subject_id) VALUES ($1, 'issue', gen_random_uuid())"
      : "INSERT INTO moderation_actions (subject, rule_cited, action) VALUES ($1, 'rule-1', 'warn')";

  it("service_role can INSERT and SELECT", async () => {
    const marker = `immutability-${randomUUID().slice(0, 8)}`;
    await withRole(databaseUrl, "service_role", async (client) => {
      await client.query(insertRow, [marker]);
      const column = table === "event_log" ? "kind" : "subject";
      const result = await client.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [marker]);
      expect(result.rows).toHaveLength(1);
    });
  });

  it("service_role UPDATE is rejected by Postgres, not just app code", async () => {
    await withRole(databaseUrl, "service_role", async (client) => {
      const column = table === "event_log" ? "kind" : "subject";
      await expect(
        client.query(`UPDATE ${table} SET ${column} = 'tampered' WHERE true`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("service_role DELETE is rejected by Postgres, not just app code", async () => {
    await withRole(databaseUrl, "service_role", async (client) => {
      await expect(client.query(`DELETE FROM ${table} WHERE true`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("anon has no access at all (no SELECT grant)", async () => {
    await withRole(databaseUrl, "anon", async (client) => {
      await expect(client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
