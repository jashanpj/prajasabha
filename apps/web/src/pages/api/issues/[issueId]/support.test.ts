import { randomUUID } from "node:crypto";
import { schema } from "db";
import { and, eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handleSupport } from "./support";

// Issue #26 (B3 — Support & Dedup). handleSupport is session-authed and
// T2-gated ("T2 users can 'Support' issues" — the story's own text; #24's
// create.ts already established the "check members.tier at the endpoint,
// not a re-usable middleware" convention this mirrors). Body is
// `{wardId}` — the *supporting* member's own ward, validated against the
// same config-driven loadPilotWardsConfig allow-list #24/#25 already use
// (nothing captures a member's ward today; the approved plan resolves this
// gap by prompting for it at support time rather than a schema change).
// 409 if the issue is still a draft (support only makes sense once an
// issue is published/routed, mirroring #25's flag-routing 409 semantics).
// Dedup relies on issue_support's real unique(issue_id, member_id)
// constraint (packages/db/src/schema.ts) — a genuine second insert for the
// same (issue, member) pair must hit Postgres's 23505 unique-violation and
// be translated to a 409 {error: "already_supported"}, not pre-checked
// with a SELECT (a race per the approved plan's own dedup rationale) and
// not surfaced as an unhandled 500. Same real-Postgres-via-APP_DATABASE_URL
// test convention as every other endpoint test in this codebase.

const ALLOWED_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NOT_ALLOWED_WARD_ID = "5b1b6e1e-1c1a-4e1a-9c1a-2c963f66afa6";

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
    PILOT_WARD_IDS: ALLOWED_WARD_ID,
    PILOT_WARD_NAMES_ML: "വാർഡ് 1",
    PILOT_WARD_NAMES_EN: "Ward 1",
    RATE_LIMIT_KV: fakeKv(),
    ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
    // B4 (issue #27) — handleSupport's promotion CAS reads these via
    // loadConfig(). CONCERN_THRESHOLD_T2 must match .env's real value
    // (100) since these tests exercise loadConfig() for real, not a stub.
    CONCERN_THRESHOLD_T2: "100",
    QUORUM_PERCENT: "20",
    PANEL_TERM_MONTHS: "6",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t2"): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-support-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `issue-support-test-${randomUUID().slice(0, 8)}`,
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

async function deleteIssueSupport(issueId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.issueSupport).where(eq(schema.issueSupport.issueId, issueId));
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

// B4 (issue #27) — direct DB helpers to put an issue into a specific
// pre-threshold/pre-promoted state without needing 99+ real support rows.
async function setSupportCount(issueId: string, count: number): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db
    .update(schema.issues)
    .set({ supportT2Count: count })
    .where(eq(schema.issues.issueId, issueId));
}

async function setPromotedAt(issueId: string, at: Date): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.update(schema.issues).set({ promotedAt: at }).where(eq(schema.issues.issueId, issueId));
}

async function getPromotionEventLogRows(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db
    .select()
    .from(schema.eventLog)
    .where(
      and(
        eq(schema.eventLog.subjectId, issueId),
        eq(schema.eventLog.kind, "issue_promoted_to_concern"),
      ),
    );
}

async function getIssueSupportRow(issueId: string, memberId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db
    .select()
    .from(schema.issueSupport)
    .where(
      and(eq(schema.issueSupport.issueId, issueId), eq(schema.issueSupport.memberId, memberId)),
    );
  return row;
}

function callSupport(
  env: ReturnType<typeof testEnv>,
  issueId: string,
  body: unknown,
  cookie?: string,
): ReturnType<typeof handleSupport> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/issues/${issueId}/support`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleSupport(request, env, issueId);
}

describe("handleSupport (POST /api/issues/:issueId/support)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callSupport(testEnv(), randomUUID(), { wardId: ALLOWED_WARD_ID });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a t0 member — only T2 can support an issue", async () => {
    const memberId = await insertMember("t0");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 403 for a t1 member — only T2 can support an issue", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 404 when the issue does not exist", async () => {
    const memberId = await insertMember("t2");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), randomUUID(), { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 409 when the issue is still a draft", async () => {
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "draft" });
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 400 when wardId is missing", async () => {
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), issueId, {}, cookie);
      expect(res.status).toBe(400);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 400 when wardId is not in the configured pilot-ward allow-list", async () => {
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callSupport(testEnv(), issueId, { wardId: NOT_ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(400);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("rejects once the per-member support rate limit is exceeded", async () => {
    const memberA = await insertMember("t2");
    const memberB = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberA, { status: "published" });
      const env = testEnv({ ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });
      const cookieB = await sessionCookie(memberB);

      const first = await callSupport(env, issueId, { wardId: ALLOWED_WARD_ID }, cookieB);
      expect(first.status).toBe(201);

      const second = await callSupport(env, issueId, { wardId: ALLOWED_WARD_ID }, cookieB);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberA);
      await deleteMember(memberB);
    }
  });

  it("returns 201 on the happy path, inserts an issue_support row, and increments supportT2Count", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(owner, { status: "published" });
      const before = await getIssue(issueId);
      expect(before?.supportT2Count).toBe(0);

      const cookie = await sessionCookie(supporter);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(201);

      const row = await getIssueSupportRow(issueId, supporter);
      expect(row?.issueId).toBe(issueId);
      expect(row?.memberId).toBe(supporter);
      expect(row?.wardId).toBe(ALLOWED_WARD_ID);

      const after = await getIssue(issueId);
      expect(after?.supportT2Count).toBe(1);
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });

  it("returns 409 already_supported on a genuine second support by the same T2 member for the same issue (real unique-constraint hit, not a pre-check)", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(owner, { status: "published" });
      const cookie = await sessionCookie(supporter);

      const first = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(first.status).toBe(201);

      const second = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "already_supported" });

      // The constraint, not a naive pre-check, is what's under test here:
      // exactly one row must exist after both calls, and supportT2Count
      // must not have been double-incremented by the rejected second call.
      const rows = await getServiceRoleDb(appDatabaseUrl())
        .select()
        .from(schema.issueSupport)
        .where(
          and(
            eq(schema.issueSupport.issueId, issueId),
            eq(schema.issueSupport.memberId, supporter),
          ),
        );
      expect(rows).toHaveLength(1);

      const after = await getIssue(issueId);
      expect(after?.supportT2Count).toBe(1);
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });

  // B4 — Constituency Concern threshold & promotion (issue #27). The three
  // tests below drive an issue right up to (and past) CONCERN_THRESHOLD_T2
  // (100, per .env / testEnv() above) via a direct DB write to
  // supportT2Count rather than 99+ real support rows, then exercise the
  // real handleSupport call that crosses (or doesn't cross) the threshold.

  it("fires exactly one issue_promoted_to_concern event when a support call crosses the threshold", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(owner, { status: "published" });
      await setSupportCount(issueId, 99);

      const cookie = await sessionCookie(supporter);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(201);

      const after = await getIssue(issueId);
      expect(after?.supportT2Count).toBe(100);
      expect(after?.promotedAt).not.toBeNull();

      const rows = await getPromotionEventLogRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.subjectType).toBe("issue");
      expect(rows[0]?.subjectId).toBe(issueId);
      expect(rows[0]?.payload).toEqual({ supportT2Count: 100 });
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });

  it("does not re-fire the promotion event when an already-promoted issue's count is crossed again", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(owner, { status: "published" });
      await setSupportCount(issueId, 150);
      const alreadyPromotedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await setPromotedAt(issueId, alreadyPromotedAt);

      const cookie = await sessionCookie(supporter);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(201);

      const after = await getIssue(issueId);
      expect(after?.supportT2Count).toBe(151);
      expect(after?.promotedAt).not.toBeNull();
      expect(after?.promotedAt?.getTime()).toBe(alreadyPromotedAt.getTime());

      // The CAS update's WHERE promoted_at IS NULL clause must prevent a
      // second promotion event from ever firing for this issue.
      const rows = await getPromotionEventLogRows(issueId);
      expect(rows).toHaveLength(0);
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });

  it("does not promote an issue whose supportT2Count is still below the threshold", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(owner, { status: "published" });

      const before = await getIssue(issueId);
      expect(before?.supportT2Count).toBe(0);

      const cookie = await sessionCookie(supporter);
      const res = await callSupport(testEnv(), issueId, { wardId: ALLOWED_WARD_ID }, cookie);
      expect(res.status).toBe(201);

      const after = await getIssue(issueId);
      expect(after?.supportT2Count).toBe(1);
      expect(after?.promotedAt).toBeNull();

      const rows = await getPromotionEventLogRows(issueId);
      expect(rows).toHaveLength(0);
    } finally {
      if (issueId) await deleteIssueSupport(issueId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });
});
