import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessLog } from "./schema";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// vault.access_log (issue #23 / A4). Real Postgres, real roles — every
// assertion is an accepted/rejected query against the actual policies and
// GRANTs from migrations/0002_add_access_log.sql.
//
// This table is the vault's ONLY append-only table, and it is append-only for
// a specific reason: vault_role is the role that performs the identity reads
// being audited. If it could also UPDATE or DELETE this table, a compromised
// vault_role could read the vault and then erase the evidence — there would
// be no audit trail. So the immutability block below is the point of the
// table, not a nice-to-have.
//
// Mirrors rls.test.ts's throwaway-role pattern and
// packages/db/src/immutability.test.ts's permission-denied assertions.

let vaultDatabaseUrl: string;
const noAccessRole = `vault_alog_test_no_access_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: vaultDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Fixtures use a REAL operation name from apps/vault-svc's closed vocabulary
// rather than a made-up one. This table is shared across the test database, and
// apps/vault-svc's own access-log.test.ts asserts that every row's `operation`
// is from that vocabulary — junk values here would fail that test from another
// package. Rows are identified by their returned access_id, not by the
// operation string.
async function insertRow(overrides: { operation?: string; rowCount?: number } = {}) {
  return withRole(vaultDatabaseUrl, "vault_role", async (client) => {
    const result = await client.query<{ access_id: string }>(
      `INSERT INTO vault.access_log (operation, subject_ref, caller, outcome, row_count)
       VALUES ($1, $2, 'internal', 'ok', $3)
       RETURNING access_id`,
      [overrides.operation ?? "epic.status", randomUUID(), overrides.rowCount ?? 1],
    );
    return result.rows[0]?.access_id as string;
  });
}

beforeAll(async () => {
  vaultDatabaseUrl = ensureMigrated();
  await withSuperuser((client) => client.query(`CREATE ROLE "${noAccessRole}" NOLOGIN`));
});

afterAll(async () => {
  await withSuperuser((client) => client.query(`DROP ROLE IF EXISTS "${noAccessRole}"`));
});

describe("vault.access_log RLS", () => {
  it("vault_role can INSERT and SELECT", async () => {
    const accessId = await insertRow();
    expect(accessId).toBeDefined();

    await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const result = await client.query("SELECT * FROM vault.access_log WHERE access_id = $1", [
        accessId,
      ]);
      expect(result.rows).toHaveLength(1);
    });
  });

  // withRole is typed to "vault_role" only, so a throwaway role goes through
  // withSuperuser + an explicit SET ROLE — same shape as rls.test.ts.
  it("a zero-grant role cannot SELECT", async () => {
    await insertRow();
    await withSuperuser(async (client) => {
      await client.query(`SET ROLE "${noAccessRole}"`);
      await expect(client.query("SELECT * FROM vault.access_log LIMIT 1")).rejects.toThrow(
        /permission denied/,
      );
      await client.query("RESET ROLE");
    });
  });

  it("a zero-grant role cannot INSERT", async () => {
    await withSuperuser(async (client) => {
      await client.query(`SET ROLE "${noAccessRole}"`);
      await expect(
        client.query(
          `INSERT INTO vault.access_log (operation, caller, outcome, row_count)
           VALUES ('epic.status', 'internal', 'ok', 1)`,
        ),
      ).rejects.toThrow(/permission denied/);
      await client.query("RESET ROLE");
    });
  });
});

describe("vault.access_log is append-only", () => {
  // Note the UPDATE uses a VALID enum value on purpose. An invalid one (e.g.
  // 'tampered') fails enum validation before Postgres ever reaches the
  // privilege check, which would make this test pass for the wrong reason.
  it("vault_role cannot UPDATE an existing row", async () => {
    const accessId = await insertRow();
    await expect(
      withRole(vaultDatabaseUrl, "vault_role", (client) =>
        client.query("UPDATE vault.access_log SET outcome = 'denied' WHERE access_id = $1", [
          accessId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("vault_role cannot DELETE a row", async () => {
    const accessId = await insertRow();
    await expect(
      withRole(vaultDatabaseUrl, "vault_role", (client) =>
        client.query("DELETE FROM vault.access_log WHERE access_id = $1", [accessId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // TRUNCATE is a separate privilege from DELETE and is not governed by RLS at
  // all, so revoking DELETE alone would still leave a way to wipe the audit
  // trail wholesale — which matters because this repo already uses blanket
  // `GRANT ALL ON SCHEMA vault` in docker/postgres/init.
  it("vault_role cannot TRUNCATE the table", async () => {
    await insertRow();
    await expect(
      withRole(vaultDatabaseUrl, "vault_role", (client) =>
        client.query("TRUNCATE vault.access_log"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("the row survives an attempted tamper", async () => {
    const accessId = await insertRow({ operation: "epic.review_queue", rowCount: 7 });
    await withRole(vaultDatabaseUrl, "vault_role", (client) =>
      client
        .query("UPDATE vault.access_log SET row_count = 0 WHERE access_id = $1", [accessId])
        .catch(() => undefined),
    );
    await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const result = await client.query<{ operation: string; row_count: number }>(
        "SELECT operation, row_count FROM vault.access_log WHERE access_id = $1",
        [accessId],
      );
      expect(result.rows[0]?.operation).toBe("epic.review_queue");
      expect(result.rows[0]?.row_count).toBe(7);
    });
  });
});

// CLAUDE.md invariant 1 (the vault join rule) is the live risk in this table:
// it lives in the vault, so it may reference identity rows, but it must never
// acquire a civic-activity attribute. A column named for an issue, statement,
// vote, support record or deliberation would make a single vault row answer
// "which member did which civic thing" — exactly the join the whole
// architecture exists to prevent. This asserts the column list structurally
// so adding such a column fails a test rather than passing review.
describe("vault.access_log holds no civic-activity attribute (invariant 1)", () => {
  const FORBIDDEN = ["issue", "statement", "vote", "support", "deliberation", "consensus", "ward"];

  // getTableColumns, not Object.keys: a Drizzle table object also carries
  // non-column keys such as `enableRLS`.
  //
  // Exact-match on purpose. Note there is deliberately NO free-form jsonb
  // column: an earlier draft had a `detail` bag, and a `{ issueId }` inside
  // jsonb would satisfy every column-name check below while putting a civic id
  // in the identity vault. Anything this log needs to record gets a typed
  // column and a migration.
  it("has exactly the expected columns, and no free-form bag", () => {
    expect(Object.keys(getTableColumns(accessLog)).sort()).toEqual([
      "accessId",
      "at",
      "caller",
      "operation",
      "outcome",
      "rowCount",
      "subjectRef",
    ]);
  });

  it("has no jsonb column at all", async () => {
    await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const result = await client.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'vault' AND table_name = 'access_log'`,
      );
      expect(result.rows.map((r) => r.data_type)).not.toContain("jsonb");
    });
  });

  // The enum is the real enforcement: recording a civic operation name is a
  // constraint violation at the database, not a code-review conversation.
  it("rejects an operation name outside the enum", async () => {
    await expect(
      withRole(vaultDatabaseUrl, "vault_role", (client) =>
        client.query(
          `INSERT INTO vault.access_log (operation, caller, outcome, row_count)
           VALUES ('issue.support.read', 'internal', 'ok', 1)`,
        ),
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it.each(FORBIDDEN)("has no column referring to %s", (term) => {
    const columns = Object.keys(getTableColumns(accessLog)).map((c) => c.toLowerCase());
    expect(columns.filter((c) => c.includes(term))).toEqual([]);
  });

  it("has no column referring to a civic attribute in the live database either", async () => {
    await withRole(vaultDatabaseUrl, "vault_role", async (client) => {
      const result = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'vault' AND table_name = 'access_log'`,
      );
      const names = result.rows.map((r) => r.column_name.toLowerCase());
      for (const term of FORBIDDEN) {
        expect(names.filter((n) => n.includes(term))).toEqual([]);
      }
    });
  });
});
