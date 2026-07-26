import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { handleStatementCreate } from "./statements";

// Issue #33 (C1 — Statement Submission & Voting). Same real-Postgres
// convention as every endpoint test in this codebase, and the same
// single-shared-client-per-file fix issue #35's support.test.ts needed —
// one pg Pool for the whole file.

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
    STATEMENT_SUBMIT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
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
    .values({ pseudonym: `stmt-create-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `stmt-create-test-${randomUUID().slice(0, 8)}`,
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

async function deleteStatements(deliberationId: string): Promise<void> {
  await db.delete(schema.statements).where(eq(schema.statements.deliberationId, deliberationId));
}

function callCreate(
  env: ReturnType<typeof testEnv>,
  deliberationId: string,
  body: unknown,
  cookie?: string,
): ReturnType<typeof handleStatementCreate> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(
    `https://prajasabha.example/api/deliberations/${deliberationId}/statements`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  return handleStatementCreate(request, env, deliberationId);
}

describe("handleStatementCreate (POST /api/deliberations/:deliberationId/statements)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callCreate(testEnv(), randomUUID(), { body: "hello" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the deliberation does not exist", async () => {
    const memberId = await insertMember("t2");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(testEnv(), randomUUID(), { body: "hello" }, cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 403 for a t0 member — only T2 can submit statements", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t0");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(testEnv(), deliberationId, { body: "hello" }, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  it("returns 409 when the deliberation is closed", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId, "closed");
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(testEnv(), deliberationId, { body: "hello" }, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  // Security-review regression (issue #33): the parent issue's status must
  // be re-checked here too, not just the deliberation's own state — #26's
  // merge endpoint can flip an issue to 'merged'/'closed' without touching
  // its deliberation row, and statements_public_read's RLS already treats
  // that as invisible (migration 0010) — this endpoint's service-role
  // connection bypasses RLS, so it must enforce the same gate itself.
  it("returns 404 when the parent issue has been merged (deliberation itself is still 'open')", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId, "open");
      await setIssueStatus(issueId, "merged");
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(testEnv(), deliberationId, { body: "hello" }, cookie);
      expect(res.status).toBe(404);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  it("returns 400 when the body exceeds 280 characters", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(testEnv(), deliberationId, { body: "a".repeat(281) }, cookie);
      expect(res.status).toBe(400);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  it("returns 201 on the happy path and inserts a pending statement", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      const cookie = await sessionCookie(memberId);
      const res = await callCreate(
        testEnv(),
        deliberationId,
        { body: "The underpass should be closed during red alerts." },
        cookie,
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.statementId).toBeTruthy();

      const [row] = await db
        .select()
        .from(schema.statements)
        .where(eq(schema.statements.statementId, json.statementId));
      expect(row?.status).toBe("pending");
      expect(row?.authorMemberId).toBe(memberId);
      expect(row?.deliberationId).toBe(deliberationId);
    } finally {
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });

  it("rejects once the per-member submit rate limit is exceeded", async () => {
    const owner = await insertMember("t1");
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(owner);
      deliberationId = await insertDeliberation(issueId);
      const env = testEnv({ STATEMENT_SUBMIT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });
      const cookie = await sessionCookie(memberId);

      const first = await callCreate(env, deliberationId, { body: "first" }, cookie);
      expect(first.status).toBe(201);

      const second = await callCreate(env, deliberationId, { body: "second" }, cookie);
      expect(second.status).toBe(429);
    } finally {
      if (deliberationId) await deleteStatements(deliberationId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
      await deleteMember(owner);
    }
  });
});
