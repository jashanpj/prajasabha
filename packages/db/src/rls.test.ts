import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// Real Postgres, real roles — every assertion here is a rejected/accepted
// query against actual RLS policies + GRANTs from
// migrations/0000_init_participation_schema.sql, not an app-level check.
// Requires DATABASE_URL (docker compose up -d locally; CI's postgres:16
// service in CI). See CONTRIBUTING.md.

function firstRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row back from the query");
  return row;
}

let databaseUrl: string;
const runId = randomUUID().slice(0, 8);
const pseudonym = `rls-test-${runId}`;
const draftSlug = `rls-draft-${runId}`;
const publishedSlug = `rls-published-${runId}`;
let memberId: string;

beforeAll(async () => {
  databaseUrl = await ensureMigrated();

  await withRole(databaseUrl, "service_role", async (client) => {
    const member = await client.query<{ member_id: string }>(
      "INSERT INTO members (pseudonym, tier) VALUES ($1, 't1') RETURNING member_id",
      [pseudonym],
    );
    memberId = firstRow(member.rows).member_id;

    await client.query(
      `INSERT INTO issues (slug, title_ml, title_en, body, category, ward_id, status, created_by)
       VALUES ($1, 'ml', 'en', 'body', 'roads', gen_random_uuid(), 'draft', $2)`,
      [draftSlug, memberId],
    );
    await client.query(
      `INSERT INTO issues (slug, title_ml, title_en, body, category, ward_id, status, created_by)
       VALUES ($1, 'ml', 'en', 'body', 'roads', gen_random_uuid(), 'published', $2)`,
      [publishedSlug, memberId],
    );
  });
});

afterAll(async () => {
  await withRole(databaseUrl, "service_role", async (client) => {
    await client.query("DELETE FROM issues WHERE slug = ANY($1)", [[draftSlug, publishedSlug]]);
    await client.query("DELETE FROM members WHERE pseudonym = $1", [pseudonym]);
  });
});

describe("issues RLS", () => {
  it("anon sees only published issues, never drafts", async () => {
    const slugs = await withRole(databaseUrl, "anon", async (client) => {
      const result = await client.query<{ slug: string }>(
        "SELECT slug FROM issues WHERE slug = ANY($1)",
        [[draftSlug, publishedSlug]],
      );
      return result.rows.map((r) => r.slug);
    });
    expect(slugs).toEqual([publishedSlug]);
  });

  it("anon cannot INSERT into issues directly", async () => {
    await expect(
      withRole(databaseUrl, "anon", (client) =>
        client.query(
          `INSERT INTO issues (slug, title_ml, title_en, body, category, ward_id, status, created_by)
           VALUES ('anon-attempt', 'ml', 'en', 'body', 'roads', gen_random_uuid(), 'published', $1)`,
          [memberId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("service_role can read draft and published issues", async () => {
    const slugs = await withRole(databaseUrl, "service_role", async (client) => {
      const result = await client.query<{ slug: string }>(
        "SELECT slug FROM issues WHERE slug = ANY($1) ORDER BY slug",
        [[draftSlug, publishedSlug]],
      );
      return result.rows.map((r) => r.slug);
    });
    expect(slugs).toEqual([draftSlug, publishedSlug].sort());
  });
});

describe("members RLS (default-deny — vault join rule, no public member directory)", () => {
  it("anon cannot SELECT members at all", async () => {
    await expect(
      withRole(databaseUrl, "anon", (client) => client.query("SELECT * FROM members LIMIT 1")),
    ).rejects.toThrow(/permission denied/);
  });

  it("anon cannot INSERT members", async () => {
    await expect(
      withRole(databaseUrl, "anon", (client) =>
        client.query("INSERT INTO members (pseudonym) VALUES ('anon-attempt')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("authorities RLS (public directory, no status gate)", () => {
  it("anon can read authorities", async () => {
    await expect(
      withRole(databaseUrl, "anon", (client) => client.query("SELECT * FROM authorities LIMIT 1")),
    ).resolves.toBeDefined();
  });
});

describe("routings RLS (join-gated on published issues)", () => {
  it("anon cannot see routings for a draft issue", async () => {
    const authorityId = await withRole(databaseUrl, "service_role", async (client) => {
      const authority = await client.query<{ authority_id: string }>(
        "INSERT INTO authorities (kind, name_ml, name_en) VALUES ('councillor', 'ml', 'en') RETURNING authority_id",
      );
      const { authority_id: newAuthorityId } = firstRow(authority.rows);
      await client.query(
        `INSERT INTO routings (issue_id, authority_id, role)
         SELECT issue_id, $1, 'responsible' FROM issues WHERE slug = $2`,
        [newAuthorityId, draftSlug],
      );
      return newAuthorityId;
    });

    try {
      const rows = await withRole(databaseUrl, "anon", async (client) => {
        const result = await client.query(
          "SELECT r.* FROM routings r JOIN issues i ON i.issue_id = r.issue_id WHERE i.slug = $1",
          [draftSlug],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await withRole(databaseUrl, "service_role", async (client) => {
        await client.query("DELETE FROM routings WHERE authority_id = $1", [authorityId]);
        await client.query("DELETE FROM authorities WHERE authority_id = $1", [authorityId]);
      });
    }
  });
});
