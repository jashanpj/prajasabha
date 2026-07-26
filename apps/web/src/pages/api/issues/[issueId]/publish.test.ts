import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handlePublish } from "./publish";

// Issue #24 (B1 — Raise an Issue form). handlePublish shares
// draft.ts/photos.ts's session/ownership guards plus a 409-if-already-
// published guard, then re-validates the issue's OWN currently-saved
// fields (not a new request body — publish reads back what autosave
// already persisted) against the full issueCreateSchema shape being
// non-empty, and category/wardId being in the config-driven allow-lists
// (loadIssueCategoriesConfig / loadPilotWardsConfig) — 422 validation_failed
// otherwise. On success: unique slug, status -> 'published'. No tier
// re-check needed (tiers are monotonic per the approved plan).

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
    ISSUE_CATEGORIES: "roads,water,electricity",
    PILOT_WARD_IDS: ALLOWED_WARD_ID,
    PILOT_WARD_NAMES_ML: "വാർഡ് 1",
    PILOT_WARD_NAMES_EN: "Ward 1",
    RATE_LIMIT_KV: fakeKv(),
    ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
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
    .values({ pseudonym: `issue-publish-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

const VALID_ISSUE_FIELDS = {
  titleMl: "ml title",
  titleEn: "en title",
  body: "body text",
  category: "roads",
  wardId: ALLOWED_WARD_ID,
};

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
      slug: overrides.slug ?? `publish-test-${randomUUID().slice(0, 8)}`,
      titleMl: overrides.titleMl ?? VALID_ISSUE_FIELDS.titleMl,
      titleEn: overrides.titleEn ?? VALID_ISSUE_FIELDS.titleEn,
      body: overrides.body ?? VALID_ISSUE_FIELDS.body,
      category: overrides.category ?? VALID_ISSUE_FIELDS.category,
      wardId: overrides.wardId ?? VALID_ISSUE_FIELDS.wardId,
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

function callPublish(
  env: ReturnType<typeof testEnv>,
  issueId: string,
  cookie?: string,
): ReturnType<typeof handlePublish> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/issues/${issueId}/publish`, {
    method: "POST",
    headers,
  });
  return handlePublish(request, env, issueId);
}

describe("handlePublish (POST /api/issues/:issueId/publish)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callPublish(testEnv(), randomUUID());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not the issue's creator", async () => {
    const ownerId = await insertMember("t1");
    const otherId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(ownerId);
      const cookie = await sessionCookie(otherId);
      const res = await callPublish(testEnv(), issueId, cookie);
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
      const res = await callPublish(testEnv(), randomUUID(), cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 409 when the issue is already published", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 422 when a required field (titleMl) is blank", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { titleMl: "" });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(422);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 422 when a required field (body) is blank", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { body: "" });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(422);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 422 when category is not in the configured allow-list", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { category: "not-a-real-category" });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(422);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 422 when wardId is not in the configured pilot-wards allow-list", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { wardId: NOT_ALLOWED_WARD_ID });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(422);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 200 on the happy path: sets status='published' and returns a unique slug", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(testEnv(), issueId, cookie);
      expect(res.status).toBe(200);

      const responseBody = (await res.json()) as { slug: string };
      expect(responseBody.slug).toBeTruthy();

      const issue = await getIssue(issueId);
      expect(issue?.status).toBe("published");
      expect(issue?.slug).toBe(responseBody.slug);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("publish generates a slug different from a second issue's independent publish", async () => {
    const memberId = await insertMember("t1");
    let issueIdA: string | undefined;
    let issueIdB: string | undefined;
    try {
      issueIdA = await insertIssue(memberId, { titleEn: "First issue" });
      issueIdB = await insertIssue(memberId, { titleEn: "Second issue" });
      const cookie = await sessionCookie(memberId);

      const resA = await callPublish(testEnv(), issueIdA, cookie);
      const resB = await callPublish(testEnv(), issueIdB, cookie);
      const { slug: slugA } = (await resA.json()) as { slug: string };
      const { slug: slugB } = (await resB.json()) as { slug: string };

      expect(slugA).not.toBe(slugB);
    } finally {
      if (issueIdA) await deleteIssue(issueIdA);
      if (issueIdB) await deleteIssue(issueIdB);
      await deleteMember(memberId);
    }
  });

  it("rejects once the per-member publish rate limit is exceeded", async () => {
    const memberId = await insertMember("t1");
    let issueIdA: string | undefined;
    let issueIdB: string | undefined;
    try {
      issueIdA = await insertIssue(memberId, { titleEn: "First issue" });
      issueIdB = await insertIssue(memberId, { titleEn: "Second issue" });
      const cookie = await sessionCookie(memberId);
      const env = testEnv({ ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });

      const first = await callPublish(env, issueIdA, cookie);
      expect(first.status).toBe(200);

      const second = await callPublish(env, issueIdB, cookie);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      if (issueIdA) await deleteIssue(issueIdA);
      if (issueIdB) await deleteIssue(issueIdB);
      await deleteMember(memberId);
    }
  });
});
