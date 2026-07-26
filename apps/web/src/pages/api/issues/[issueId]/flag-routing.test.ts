import { randomUUID } from "node:crypto";
import { schema } from "db";
import { and, eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handleFlagRouting } from "./flag-routing";

// Issue #25 (B2 — Responsibility Router). POST /api/issues/:issueId/flag-routing
// lets any authenticated member (no tier gate, no ownership check — "any
// member can flag any published issue", per the approved plan) flag a
// misrouting for admin review. There's no new table: this endpoint appends
// exactly one event_log row (kind: "issue_routing_flagged", subjectType:
// "issue", subjectId: issueId, actorMemberId: session.memberId) — matching
// the ONLY existing event_log write in this codebase
// (apps/web/src/pages/api/auth/register/verify.ts's
// registration_failed_after_token_consumed insert) exactly. 409 if the
// issue is still a draft (flagging only makes sense once an issue is
// published and routed). Rate-limited per-member via the new
// loadFlagRoutingRateLimitConfig loader, same split-per-endpoint pattern
// #24 established. event_log rows are append-only (no DELETE grant to any
// role, including service_role — see packages/db/src/schema.ts's comment),
// so this file — like every other test in this codebase that writes to
// event_log — does not (and cannot) clean those rows up; unique issueIds
// per test keep assertions from colliding with rows left by other runs.

const ALLOWED_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

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
    FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
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
    .values({ pseudonym: `flag-routing-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
  overrides: Partial<{ status: "draft" | "published" | "merged" | "closed" }> = {},
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: `flag-routing-test-${randomUUID().slice(0, 8)}`,
      titleMl: "ml title",
      titleEn: "en title",
      body: "body text",
      category: "roads",
      wardId: ALLOWED_WARD_ID,
      status: overrides.status ?? "published",
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

async function getFlagEventLogRows(issueId: string, memberId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db
    .select()
    .from(schema.eventLog)
    .where(
      and(
        eq(schema.eventLog.subjectId, issueId),
        eq(schema.eventLog.kind, "issue_routing_flagged"),
        eq(schema.eventLog.actorMemberId, memberId),
      ),
    );
}

function callFlagRouting(
  env: ReturnType<typeof testEnv>,
  issueId: string,
  cookie?: string,
): ReturnType<typeof handleFlagRouting> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/issues/${issueId}/flag-routing`, {
    method: "POST",
    headers,
    body: JSON.stringify({ note: "wrong authority" }),
  });
  return handleFlagRouting(request, env, issueId);
}

describe("handleFlagRouting (POST /api/issues/:issueId/flag-routing)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callFlagRouting(testEnv(), randomUUID());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the issue does not exist", async () => {
    const memberId = await insertMember("t1");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callFlagRouting(testEnv(), randomUUID(), cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 409 when the issue is still a draft", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "draft" });
      const cookie = await sessionCookie(memberId);
      const res = await callFlagRouting(testEnv(), issueId, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("rejects once the per-member flag-routing rate limit is exceeded", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const env = testEnv({ FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });

      const first = await callFlagRouting(env, issueId, cookie);
      expect(first.status).toBe(201);

      const second = await callFlagRouting(env, issueId, cookie);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      // Deliberately does NOT delete memberId: the first call above inserted
      // an event_log row with actorMemberId = memberId, and event_log's FK
      // to members is ON DELETE NO ACTION (append-only — see
      // packages/db/src/schema.ts) — deleting the member row would now fail
      // with a foreign-key violation. Same reasoning in the two tests below.
      if (issueId) await deleteIssue(issueId);
    }
  });

  it("returns 201 on the happy path and inserts exactly one event_log row with the right kind/subjectType/subjectId/actorMemberId", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callFlagRouting(testEnv(), issueId, cookie);
      expect(res.status).toBe(201);

      const rows = await getFlagEventLogRows(issueId, memberId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("issue_routing_flagged");
      expect(rows[0]?.subjectType).toBe("issue");
      expect(rows[0]?.subjectId).toBe(issueId);
      expect(rows[0]?.actorMemberId).toBe(memberId);
    } finally {
      if (issueId) await deleteIssue(issueId);
    }
  });

  it("any authenticated member can flag a published issue they did not create (no ownership gate)", async () => {
    const ownerId = await insertMember("t1");
    const otherId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(ownerId, { status: "published" });
      const cookie = await sessionCookie(otherId);
      const res = await callFlagRouting(testEnv(), issueId, cookie);
      expect(res.status).toBe(201);

      const rows = await getFlagEventLogRows(issueId, otherId);
      expect(rows).toHaveLength(1);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(ownerId);
      // otherId is NOT deleted — it's now referenced by an event_log row's
      // actorMemberId (append-only FK, see above).
    }
  });
});
