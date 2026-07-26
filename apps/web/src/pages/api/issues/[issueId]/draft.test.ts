import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handleDraftUpdate } from "./draft";

// Issue #24 (B1 — Raise an Issue form). handleDraftUpdate is the debounced
// autosave PATCH the client calls on input (~800ms) — session + ownership
// (issue.createdBy === session.memberId) + status === 'draft' guards
// (403/404/409), validates against issueDraftUpdateSchema, updates only
// the fields present in the body. Real Postgres via APP_DATABASE_URL, same
// convention as apps/web/src/pages/api/verify/epic/status.test.ts.

const VALID_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

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
    ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t1"): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-draft-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

async function insertIssue(
  createdBy: string,
  overrides: Partial<{
    status: "draft" | "published" | "merged" | "closed";
    titleMl: string;
    titleEn: string;
    body: string;
    category: string;
    wardId: string;
    slug: string;
  }> = {},
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: overrides.slug ?? `draft-test-${randomUUID().slice(0, 8)}`,
      titleMl: overrides.titleMl ?? "",
      titleEn: overrides.titleEn ?? "",
      body: overrides.body ?? "",
      category: overrides.category ?? "",
      wardId: overrides.wardId ?? VALID_WARD_ID,
      status: overrides.status ?? "draft",
      createdBy,
    })
    .returning({ issueId: schema.issues.issueId });
  if (!inserted) throw new Error("issue insert returned no row");
  return inserted.issueId;
}

async function deleteIssue(issueId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.issues).where(eq(schema.issues.issueId, issueId));
}

async function getIssue(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueId, issueId));
  return row;
}

function callDraftUpdate(
  body: unknown,
  env: ReturnType<typeof testEnv>,
  issueId: string,
  cookie?: string,
): ReturnType<typeof handleDraftUpdate> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/issues/${issueId}/draft`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return handleDraftUpdate(request, env, issueId);
}

describe("handleDraftUpdate (PATCH /api/issues/:issueId/draft)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callDraftUpdate({ titleMl: "x" }, testEnv(), randomUUID());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not the issue's creator", async () => {
    const ownerId = await insertMember("t1");
    const otherId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(ownerId);
      const cookie = await sessionCookie(otherId);
      const res = await callDraftUpdate({ titleMl: "hacked" }, testEnv(), issueId, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(ownerId);
      await deleteMember(otherId);
    }
  });

  it("returns 404 when the issue does not exist", async () => {
    const memberId = await insertMember("t1");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callDraftUpdate({ titleMl: "x" }, testEnv(), randomUUID(), cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 409 once the issue is no longer a draft", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, {
        status: "published",
        titleMl: "t",
        titleEn: "t",
        body: "b",
        category: "roads",
      });
      const cookie = await sessionCookie(memberId);
      const res = await callDraftUpdate({ titleMl: "changed" }, testEnv(), issueId, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("rejects an invalid partial field (wardId not a uuid)", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const res = await callDraftUpdate({ wardId: "not-a-uuid" }, testEnv(), issueId, cookie);
      expect(res.status).toBe(400);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("updates only the fields present in the body (happy path)", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { category: "roads" });
      const cookie = await sessionCookie(memberId);
      const res = await callDraftUpdate({ titleMl: "പുതിയ തലക്കെട്ട്" }, testEnv(), issueId, cookie);
      expect(res.status).toBe(200);

      const issue = await getIssue(issueId);
      expect(issue?.titleMl).toBe("പുതിയ തലക്കെട്ട്");
      // Fields not present in the PATCH body stay untouched.
      expect(issue?.category).toBe("roads");
      expect(issue?.status).toBe("draft");
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("rejects once the per-member draft-update rate limit is exceeded", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const env = testEnv({ ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });

      const first = await callDraftUpdate({ titleMl: "one" }, env, issueId, cookie);
      expect(first.status).toBe(200);

      const second = await callDraftUpdate({ titleMl: "two" }, env, issueId, cookie);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });
});
