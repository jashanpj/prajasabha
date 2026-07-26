import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { handleStatementVote } from "./vote";

// Issue #33 (C1). Same real-Postgres, single-shared-client-per-file
// convention as the sibling test files in this PR.

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

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    SESSION_SECRET: "session-secret",
    RATE_LIMIT_KV: fakeKv(),
    STATEMENT_VOTE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
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
    .values({ pseudonym: `stmt-vote-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `stmt-vote-test-${randomUUID().slice(0, 8)}`,
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

async function insertDeliberation(
  issueId: string,
  state: "open" | "extended" | "closed" | "summarized" = "open",
): Promise<string> {
  const [inserted] = await db
    .insert(schema.deliberations)
    .values({ issueId, state, closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
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

async function deleteVotesForStatement(statementId: string): Promise<void> {
  await db.delete(schema.statementVotes).where(eq(schema.statementVotes.statementId, statementId));
}

async function deleteStatement(statementId: string): Promise<void> {
  await db.delete(schema.statements).where(eq(schema.statements.statementId, statementId));
}

function callVote(
  env: ReturnType<typeof testEnv>,
  statementId: string,
  body: unknown,
  cookie?: string,
): ReturnType<typeof handleStatementVote> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/statements/${statementId}/vote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleStatementVote(request, env, statementId);
}

describe("handleStatementVote (POST /api/statements/:statementId/vote)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callVote(testEnv(), randomUUID(), { vote: "agree" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the statement does not exist", async () => {
    const memberId = await insertMember("t2");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callVote(testEnv(), randomUUID(), { vote: "agree" }, cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 404 when the statement is still pending (not yet approved)", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "pending");
      const cookie = await sessionCookie(voter);
      const res = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(res.status).toBe(404);
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 409 when the parent deliberation is closed", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId, "closed");
      statementId = await insertStatement(deliberationId, author, "approved");
      const cookie = await sessionCookie(voter);
      const res = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  // Security-review regression (issue #33) — see the sibling note in
  // statements.test.ts: a merged/closed parent issue must block voting
  // here too, not just via RLS.
  it("returns 404 when the parent issue has been merged (deliberation itself is still 'open')", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId, "open");
      statementId = await insertStatement(deliberationId, author, "approved");
      await setIssueStatus(issueId, "merged");
      const cookie = await sessionCookie(voter);
      const res = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(res.status).toBe(404);
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 403 when the caller tries to vote on their own statement", async () => {
    const owner = await insertMember("t1");
    const author = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementId = await insertStatement(deliberationId, author, "approved");
      const cookie = await sessionCookie(author);
      const res = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 201 on the happy path and records the vote", async () => {
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
      const res = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(res.status).toBe(201);

      const [row] = await db
        .select()
        .from(schema.statementVotes)
        .where(eq(schema.statementVotes.statementId, statementId));
      expect(row?.memberId).toBe(voter);
      expect(row?.vote).toBe("agree");
    } finally {
      if (statementId) await deleteVotesForStatement(statementId);
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("returns 409 already_voted on a genuine second vote by the same member for the same statement (real unique-constraint hit, not a pre-check)", async () => {
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

      const first = await callVote(testEnv(), statementId, { vote: "agree" }, cookie);
      expect(first.status).toBe(201);

      const second = await callVote(testEnv(), statementId, { vote: "disagree" }, cookie);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "already_voted" });

      const rows = await db
        .select()
        .from(schema.statementVotes)
        .where(eq(schema.statementVotes.statementId, statementId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.vote).toBe("agree"); // the rejected second call must not have changed the vote
    } finally {
      if (statementId) await deleteVotesForStatement(statementId);
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(author);
      await deleteMember(owner);
    }
  });

  it("rejects once the per-member vote rate limit is exceeded", async () => {
    const owner = await insertMember("t1");
    const authorA = await insertMember("t2");
    const authorB = await insertMember("t2");
    const voter = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementIdA: string | undefined;
    let statementIdB: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      statementIdA = await insertStatement(deliberationId, authorA, "approved");
      statementIdB = await insertStatement(deliberationId, authorB, "approved");
      const env = testEnv({ STATEMENT_VOTE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });
      const cookie = await sessionCookie(voter);

      const first = await callVote(env, statementIdA, { vote: "agree" }, cookie);
      expect(first.status).toBe(201);

      const second = await callVote(env, statementIdB, { vote: "agree" }, cookie);
      expect(second.status).toBe(429);
    } finally {
      if (statementIdA) await deleteVotesForStatement(statementIdA);
      if (statementIdB) await deleteVotesForStatement(statementIdB);
      if (statementIdA) await deleteStatement(statementIdA);
      if (statementIdB) await deleteStatement(statementIdB);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(voter);
      await deleteMember(authorA);
      await deleteMember(authorB);
      await deleteMember(owner);
    }
  });
});
