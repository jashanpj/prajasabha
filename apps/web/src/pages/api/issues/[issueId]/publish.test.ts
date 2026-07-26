import { randomUUID } from "node:crypto";
import { schema } from "db";
import { and, eq } from "drizzle-orm";
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
  // #25's router now runs on every publish — a default 'roads' issue in
  // ALLOWED_WARD_ID (one of the two real seeded pilot wards, migration
  // 0005) really does match the seeded routing_rules, so any test in this
  // file that publishes can leave real `routings` rows behind. Clear those
  // first or the FK from routings.issue_id blocks this delete.
  await db.delete(schema.routings).where(eq(schema.routings.issueId, issueId));
  await db.delete(schema.issues).where(eq(schema.issues.issueId, issueId));
}

// Issue #25 (B2 — Responsibility Router). Publishing an issue whose saved
// category/wardId matches a `routing_rules` row should insert one
// `routings` row per matched authority right after the status flips to
// 'published' — a "not yet routed" issue (zero routings) is still a valid
// publish, per the approved plan ("routing gaps shouldn't block publish").

async function insertAuthority(
  kind: "councillor" | "ulb" | "mla" | "mp" | "dept" | "agency" = "ulb",
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const suffix = randomUUID().slice(0, 8);
  const [inserted] = await db
    .insert(schema.authorities)
    .values({ kind, nameMl: `അതോറിറ്റി ${suffix}`, nameEn: `Authority ${suffix}` })
    .returning({ authorityId: schema.authorities.authorityId });
  if (!inserted) throw new Error("authority insert returned no row");
  return inserted.authorityId;
}

async function insertRoutingRule(fields: {
  category: string;
  wardId: string | null;
  authorityId: string;
  role: "responsible" | "copied";
}): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.insert(schema.routingRules).values({
    category: fields.category,
    wardId: fields.wardId,
    authorityId: fields.authorityId,
    role: fields.role,
  });
}

async function cleanupAuthority(authorityId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.routings).where(eq(schema.routings.authorityId, authorityId));
  await db.delete(schema.routingRules).where(eq(schema.routingRules.authorityId, authorityId));
  await db.delete(schema.authorities).where(eq(schema.authorities.authorityId, authorityId));
}

async function getRoutingsForIssue(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db.select().from(schema.routings).where(eq(schema.routings.issueId, issueId));
}

async function getIssue(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueId, issueId));
  return row;
}

// B5 — Issue Timeline (issue #28). event_log is append-only (no DELETE
// grant to any role) — cleanup never touches event_log rows, only the
// member/issue rows, matching this repo's existing convention.
async function getEventLogRows(issueId: string, kind: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db
    .select()
    .from(schema.eventLog)
    .where(and(eq(schema.eventLog.subjectId, issueId), eq(schema.eventLog.kind, kind)));
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

      // B5 — Issue Timeline (issue #28): publishing fires exactly one
      // event_log row of kind "issue_published".
      const events = await getEventLogRows(issueId, "issue_published");
      expect(events).toHaveLength(1);
    } finally {
      if (issueId) await deleteIssue(issueId);
      // Deliberately does NOT delete memberId: the successful publish above
      // inserted an event_log row with actorMemberId = memberId, and
      // event_log's FK to members is ON DELETE NO ACTION (append-only —
      // packages/db/src/schema.ts) — deleting the member row would now fail
      // with a foreign-key violation. Same reasoning in every other
      // "publishes successfully" test below (matches the established
      // pattern in flag-routing.test.ts).
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
      // memberId is NOT deleted — both publishes above inserted event_log
      // rows referencing it as actorMemberId (append-only FK, see above).
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
      // memberId is NOT deleted — the first (successful) publish inserted an
      // event_log row referencing it as actorMemberId (append-only FK, see
      // above).
    }
  });

  it("publishing an issue whose category/wardId matches a routing_rules row creates a routings row for the matched authority", async () => {
    const memberId = await insertMember("t1");
    const authorityId = await insertAuthority("ulb");
    // A unique category, not one of migration 0005's seeded
    // roads/water/electricity rules — so the only routing_rules row that
    // can match this issue is the one this test inserts itself, keeping
    // the toHaveLength(1) assertion below independent of real seed data.
    const category = `publish-test-routing-${randomUUID().slice(0, 8)}`;
    let issueId: string | undefined;
    try {
      await insertRoutingRule({
        category,
        wardId: null,
        authorityId,
        role: "responsible",
      });

      issueId = await insertIssue(memberId, { category, wardId: ALLOWED_WARD_ID });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(
        testEnv({ ISSUE_CATEGORIES: `roads,water,electricity,${category}` }),
        issueId,
        cookie,
      );
      expect(res.status).toBe(200);

      const routings = await getRoutingsForIssue(issueId);
      expect(routings).toHaveLength(1);
      expect(routings[0]?.authorityId).toBe(authorityId);
      expect(routings[0]?.role).toBe("responsible");
    } finally {
      if (issueId) await deleteIssue(issueId);
      // memberId is NOT deleted — the successful publish inserted an
      // event_log row referencing it as actorMemberId (append-only FK, see
      // above).
      await cleanupAuthority(authorityId);
    }
  });

  it("publishing an issue with no matching routing_rules row still succeeds with zero routings", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      // "streetlight" has no routing_rules row seeded anywhere (migration
      // 0005 only seeds roads/water/electricity) — no rule should ever
      // match it. Overriding ISSUE_CATEGORIES here since the file's shared
      // testEnv() only allow-lists roads/water/electricity.
      issueId = await insertIssue(memberId, { category: "streetlight", wardId: ALLOWED_WARD_ID });
      const cookie = await sessionCookie(memberId);
      const res = await callPublish(
        testEnv({ ISSUE_CATEGORIES: "roads,water,electricity,streetlight" }),
        issueId,
        cookie,
      );
      expect(res.status).toBe(200);

      const routings = await getRoutingsForIssue(issueId);
      expect(routings).toEqual([]);
    } finally {
      if (issueId) await deleteIssue(issueId);
      // memberId is NOT deleted — the successful publish inserted an
      // event_log row referencing it as actorMemberId (append-only FK, see
      // above).
    }
  });
});
