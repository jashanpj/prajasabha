import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { handleNextStatement } from "./next";

// Issue #33 (C1). Same real-Postgres, single-shared-client-per-file
// convention as the sibling statements.test.ts.

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
    SESSION_SECRET: "session-secret",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t2"): Promise<string> {
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `stmt-next-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `stmt-next-test-${randomUUID().slice(0, 8)}`,
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

async function setIssueStatus(
  issueId: string,
  status: "published" | "merged" | "closed",
): Promise<void> {
  await db.update(schema.issues).set({ status }).where(eq(schema.issues.issueId, issueId));
}

async function insertStatement(
  deliberationId: string,
  authorMemberId: string,
  status: "pending" | "approved" | "rejected" = "approved",
): Promise<string> {
  const [inserted] = await db
    .insert(schema.statements)
    .values({ deliberationId, authorMemberId, body: "a statement", status })
    .returning({ statementId: schema.statements.statementId });
  if (!inserted) throw new Error("statement insert returned no row");
  return inserted.statementId;
}

async function deleteStatements(deliberationId: string): Promise<void> {
  await db.delete(schema.statements).where(eq(schema.statements.deliberationId, deliberationId));
}

async function insertVote(statementId: string, memberId: string): Promise<void> {
  await db.insert(schema.statementVotes).values({ statementId, memberId, vote: "agree" });
}

async function deleteVotesByMember(memberId: string): Promise<void> {
  await db.delete(schema.statementVotes).where(eq(schema.statementVotes.memberId, memberId));
}

function callNext(
  env: ReturnType<typeof testEnv>,
  deliberationId: string,
  cookie?: string,
): ReturnType<typeof handleNextStatement> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const request = new Request(
    `https://prajasabha.example/api/deliberations/${deliberationId}/statements/next`,
    { headers },
  );
  return handleNextStatement(request, env, deliberationId);
}

describe("handleNextStatement (GET /api/deliberations/:deliberationId/statements/next)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callNext(testEnv(), randomUUID());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the deliberation does not exist", async () => {
    const memberId = await insertMember("t2");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callNext(testEnv(), randomUUID(), cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 403 for a non-T2 member", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t0");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      const cookie = await sessionCookie(memberId);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  // Security-review regression (issue #33) — see the sibling note in
  // statements.test.ts: a merged/closed parent issue must hide its
  // deliberation's statements here too, not just via RLS.
  it("returns 404 when the parent issue has been merged (deliberation itself is still 'open')", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      await setIssueStatus(issueId, "merged");
      const cookie = await sessionCookie(memberId);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(404);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  it("never serves the caller's own statement", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      await insertStatement(deliberationId, author, "approved");

      const cookie = await sessionCookie(author);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.done).toBe(true);
    } finally {
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("never re-serves a statement the caller already voted on", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "approved");
      await insertVote(statementId, voter);

      const cookie = await sessionCookie(voter);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.done).toBe(true);
      expect(json.position).toBe(1); // 1 already voted
      expect(json.total).toBe(1); // 1 approved statement total
    } finally {
      await deleteVotesByMember(voter);
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("never serves a pending (unapproved) statement", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      await insertStatement(deliberationId, author, "pending");

      const cookie = await sessionCookie(voter);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.done).toBe(true);
      expect(json.total).toBe(0); // pending statements don't count toward "approved"
    } finally {
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("serves an eligible approved statement with a 1-indexed position and always-visible total", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "approved");

      const cookie = await sessionCookie(voter);
      const res = await callNext(testEnv(), deliberationId, cookie);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.done).toBe(false);
      expect(json.statement.statementId).toBe(statementId);
      expect(json.position).toBe(1);
      expect(json.total).toBe(1);
    } finally {
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });
});
