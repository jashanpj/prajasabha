import { randomUUID } from "node:crypto";
import { schema } from "db";
import { and, eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../lib/db";
import { handleCreate } from "./create";

// Issue #24 (B1 — Raise an Issue form). handleCreate is session-authed;
// looks up the caller's members.tier in packages/db and 403s below t1 —
// the explicit authz AC in #24's test notes ("authz test — only T1+ can
// raise"). Creation only requires wardId, the one NOT-NULL issues column
// not safely defaultable; titleMl/titleEn/body/category default to '' and
// get filled in by the debounced autosave PATCH (draft.ts, tested
// separately). Same session/DB-testing pattern as
// apps/web/src/pages/api/verify/epic/status.test.ts and
// apps/web/src/pages/api/auth/register/start.test.ts — a real Postgres via
// APP_DATABASE_URL, not a mocked DB layer, matching this app's existing
// endpoint-test convention exactly.

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
    ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
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
    .values({ pseudonym: `issue-create-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
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

// B5 — Issue Timeline (issue #28). event_log is append-only (no DELETE
// grant to any role, CLAUDE.md invariant 3) — cleanup here only ever
// deletes the member/issue rows, never event_log rows, matching
// flag-routing.test.ts / merge.test.ts's existing convention in this repo.
async function getEventLogRows(issueId: string, kind: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db
    .select()
    .from(schema.eventLog)
    .where(and(eq(schema.eventLog.subjectId, issueId), eq(schema.eventLog.kind, kind)));
}

function callCreate(
  body: unknown,
  env: ReturnType<typeof testEnv>,
  cookie?: string,
): ReturnType<typeof handleCreate> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request("https://prajasabha.example/api/issues/create", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleCreate(request, env);
}

describe("handleCreate (POST /api/issues/create)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callCreate({ wardId: VALID_WARD_ID }, testEnv());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a t0 member — only T1+ can raise an issue", async () => {
    const memberId = await insertMember("t0");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate({ wardId: VALID_WARD_ID }, testEnv(), cookie);
      expect(res.status).toBe(403);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 400 when wardId is missing", async () => {
    const memberId = await insertMember("t1");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate({}, testEnv(), cookie);
      expect(res.status).toBe(400);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 400 when wardId is not a uuid", async () => {
    const memberId = await insertMember("t1");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate({ wardId: "not-a-uuid" }, testEnv(), cookie);
      expect(res.status).toBe(400);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 201 with {issueId} and creates a draft row for a t1 member", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate({ wardId: VALID_WARD_ID }, testEnv(), cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { issueId: string };
      expect(body.issueId).toBeTruthy();
      issueId = body.issueId;

      const issue = await getIssue(issueId);
      expect(issue?.status).toBe("draft");
      expect(issue?.wardId).toBe(VALID_WARD_ID);
      expect(issue?.createdBy).toBe(memberId);

      // B5 — Issue Timeline (issue #28): creating a draft fires exactly one
      // event_log row of kind "issue_created", attributed to the creator.
      const events = await getEventLogRows(issueId, "issue_created");
      expect(events).toHaveLength(1);
      expect(events[0]?.actorMemberId).toBe(memberId);
    } finally {
      if (issueId) await deleteIssue(issueId);
      // Deliberately does NOT delete memberId: the successful create above
      // inserted an event_log row with actorMemberId = memberId, and
      // event_log's FK to members is ON DELETE NO ACTION (append-only —
      // packages/db/src/schema.ts) — deleting the member row would now fail
      // with a foreign-key violation. Same reasoning in the two tests below
      // (matches the established pattern in flag-routing.test.ts).
    }
  });

  it("returns 201 for a t2 member too — tiers are monotonic (t0->t1->t2), so t2 implies raise access", async () => {
    const memberId = await insertMember("t2");
    let issueId: string | undefined;
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callCreate({ wardId: VALID_WARD_ID }, testEnv(), cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { issueId: string };
      issueId = body.issueId;
    } finally {
      if (issueId) await deleteIssue(issueId);
      // memberId is NOT deleted — it's now referenced by an event_log row's
      // actorMemberId (append-only FK, see above).
    }
  });

  it("rejects once the per-member create rate limit is exceeded", async () => {
    const memberId = await insertMember("t1");
    const env = testEnv({ ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });
    const cookie = await sessionCookie(memberId);
    let firstIssueId: string | undefined;
    try {
      const first = await callCreate({ wardId: VALID_WARD_ID }, env, cookie);
      expect(first.status).toBe(201);
      firstIssueId = ((await first.json()) as { issueId: string }).issueId;

      const second = await callCreate({ wardId: VALID_WARD_ID }, env, cookie);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      if (firstIssueId) await deleteIssue(firstIssueId);
      // memberId is NOT deleted — the first (successful) call inserted an
      // event_log row with actorMemberId = memberId (append-only FK, see
      // above).
    }
  });
});
