import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { handleStatementModerate } from "./moderate";

// Issue #33 (C1 — minimal admin-gated moderation). Same real-Postgres,
// single-shared-client-per-file convention as the sibling test files, and
// the same bearer-token + IP-allowlist auth-test structure as #26's
// merge.test.ts.

const ADMIN_TOKEN = "moderation-admin-token";
const ALLOWED_IP = "127.0.0.1";
const NOT_ALLOWED_IP = "203.0.113.99";

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

const db = createDbClient(appDatabaseUrl());

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    STATEMENT_MODERATION_ADMIN_TOKEN: ADMIN_TOKEN,
    STATEMENT_MODERATION_ADMIN_IP_ALLOWLIST: ALLOWED_IP,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t2"): Promise<string> {
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `stmt-moderate-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

async function insertIssue(createdBy: string): Promise<string> {
  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: `stmt-moderate-test-${randomUUID().slice(0, 8)}`,
      titleMl: "ml title",
      titleEn: "en title",
      body: "body text",
      category: "roads",
      wardId: randomUUID(),
      status: "published",
      createdBy,
      promotedAt: new Date(),
    })
    .returning({ issueId: schema.issues.issueId });
  if (!inserted) throw new Error("issue insert returned no row");
  return inserted.issueId;
}

async function deleteIssue(issueId: string): Promise<void> {
  await db.delete(schema.issues).where(eq(schema.issues.issueId, issueId));
}

async function insertDeliberation(issueId: string): Promise<string> {
  const [inserted] = await db
    .insert(schema.deliberations)
    .values({ issueId, closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .returning({ deliberationId: schema.deliberations.deliberationId });
  if (!inserted) throw new Error("deliberation insert returned no row");
  return inserted.deliberationId;
}

async function deleteDeliberation(deliberationId: string): Promise<void> {
  await db
    .delete(schema.deliberations)
    .where(eq(schema.deliberations.deliberationId, deliberationId));
}

async function insertStatement(
  deliberationId: string,
  authorMemberId: string,
  status: "pending" | "approved" | "rejected" = "pending",
): Promise<string> {
  const [inserted] = await db
    .insert(schema.statements)
    .values({ deliberationId, authorMemberId, body: "a statement", status })
    .returning({ statementId: schema.statements.statementId });
  if (!inserted) throw new Error("statement insert returned no row");
  return inserted.statementId;
}

async function deleteStatement(statementId: string): Promise<void> {
  await db.delete(schema.statements).where(eq(schema.statements.statementId, statementId));
}

async function getStatement(statementId: string) {
  const [row] = await db
    .select()
    .from(schema.statements)
    .where(eq(schema.statements.statementId, statementId));
  return row;
}

function callModerate(
  env: ReturnType<typeof testEnv>,
  statementId: string,
  body: unknown,
  token?: string,
  clientAddress = ALLOWED_IP,
): ReturnType<typeof handleStatementModerate> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const request = new Request(
    `https://prajasabha.example/api/admin/statements/${statementId}/moderate`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  return handleStatementModerate(request, env, statementId, clientAddress);
}

describe("handleStatementModerate (POST /api/admin/statements/:statementId/moderate)", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await callModerate(testEnv(), randomUUID(), {
      action: "approve",
      ruleCited: "civility",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await callModerate(
      testEnv(),
      randomUUID(),
      { action: "approve", ruleCited: "civility" },
      "wrong-token",
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 from a non-allow-listed IP even with the correct token", async () => {
    const res = await callModerate(
      testEnv(),
      randomUUID(),
      { action: "approve", ruleCited: "civility" },
      ADMIN_TOKEN,
      NOT_ALLOWED_IP,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the statement does not exist", async () => {
    const res = await callModerate(
      testEnv(),
      randomUUID(),
      { action: "approve", ruleCited: "civility" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 and approves a pending statement, logging a moderation action", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "pending");

      const res = await callModerate(
        testEnv(),
        statementId,
        { action: "approve", ruleCited: "civility" },
        ADMIN_TOKEN,
      );
      expect(res.status).toBe(200);

      const row = await getStatement(statementId);
      expect(row?.status).toBe("approved");

      const actions = await db
        .select()
        .from(schema.moderationActions)
        .where(
          and(
            eq(schema.moderationActions.subject, `statement:${statementId}`),
            eq(schema.moderationActions.action, "approve"),
          ),
        );
      expect(actions).toHaveLength(1);
      expect(actions[0]?.ruleCited).toBe("civility");
    } finally {
      // moderation_actions is append-only (CLAUDE.md invariant 3) — no
      // DELETE grant exists for any role, so cleanup never touches it, same
      // precedent as merge.test.ts and event_log.
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 200 and rejects a pending statement with a public note", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "pending");

      const res = await callModerate(
        testEnv(),
        statementId,
        { action: "reject", ruleCited: "civility", publicNote: "Personal attack." },
        ADMIN_TOKEN,
      );
      expect(res.status).toBe(200);

      const row = await getStatement(statementId);
      expect(row?.status).toBe("rejected");

      const actions = await db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.subject, `statement:${statementId}`));
      expect(actions[0]?.publicNote).toBe("Personal attack.");
    } finally {
      // moderation_actions is append-only (CLAUDE.md invariant 3) — no
      // DELETE grant exists for any role, so cleanup never touches it, same
      // precedent as merge.test.ts and event_log.
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 409 when the statement has already been moderated", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "approved");

      const res = await callModerate(
        testEnv(),
        statementId,
        { action: "reject", ruleCited: "civility" },
        ADMIN_TOKEN,
      );
      expect(res.status).toBe(409);
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });
});
