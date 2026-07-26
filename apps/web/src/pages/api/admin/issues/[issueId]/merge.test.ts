import { randomUUID } from "node:crypto";
import { schema } from "db";
import { and, eq, inArray, or } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../../../lib/db";
import { handleMerge } from "./merge";

// Issue #26 (B3 — Support & Dedup). POST /api/admin/issues/:issueId/merge
// (issueId = the SOURCE issue, body {targetIssueId}) is internal-ops-only —
// there is no admin-role model anywhere in this codebase yet (approved
// plan), so this is gated the same token+IP-allowlist way
// apps/vault-svc/src/review-auth.ts's requireReviewAccess already gates
// `/review/epic/*`: two independent factors (a correct Authorization:
// Bearer token AND an allow-listed caller IP), via a new
// loadIssueMergeAdminConfig loader. Unlike vault-svc's Hono middleware,
// apps/web has no Hono — handleMerge takes the caller's IP as an explicit
// 4th parameter (clientAddress) rather than reading a header, so this is a
// plain, directly-testable function (matching handleStart's clientAddress
// parameter in apps/web/src/pages/api/auth/register/start.ts).
//
// On success, in one transaction: issue_support rows pointing at source
// are re-pointed to target (skipping — via ON CONFLICT DO NOTHING on the
// existing unique(issue_id, member_id) constraint — any member who already
// supports target, so nothing is deleted for a non-overlapping member and
// no duplicate/constraint-violation is ever raised for an overlapping
// one); target's supportT2Count is recomputed as a fresh COUNT(*) (not
// incremented, to avoid double-counting); and source's own row is never
// deleted — status flips to 'merged' and mergedInto is set to target, so
// both issues' own history/pages stay reachable ("merge preserves both
// threads' history" — issue #26's own AC, and the test-notes' explicit
// "merge test asserting both histories survive").

const ALLOWED_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ADMIN_TOKEN = "merge-admin-token";
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

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    ISSUE_MERGE_ADMIN_TOKEN: ADMIN_TOKEN,
    ISSUE_MERGE_ADMIN_IP_ALLOWLIST: ALLOWED_IP,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t2"): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-merge-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `issue-merge-test-${randomUUID().slice(0, 8)}`,
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

async function insertIssueSupport(issueId: string, memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.insert(schema.issueSupport).values({ issueId, memberId, wardId: ALLOWED_WARD_ID });
}

async function deleteIssueSupportFor(issueIds: string[]): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.issueSupport).where(inArray(schema.issueSupport.issueId, issueIds));
}

async function getIssue(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueId, issueId));
  return row;
}

async function getIssueSupportRowsFor(issueIds: string[], memberId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  return db
    .select()
    .from(schema.issueSupport)
    .where(
      and(
        eq(schema.issueSupport.memberId, memberId),
        or(...issueIds.map((id) => eq(schema.issueSupport.issueId, id))),
      ),
    );
}

function callMerge(
  env: ReturnType<typeof testEnv>,
  sourceIssueId: string,
  targetIssueId: string,
  options: { token?: string | null; clientAddress?: string } = {},
): ReturnType<typeof handleMerge> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? ADMIN_TOKEN}`;
  }
  const request = new Request(
    `https://prajasabha.example/api/admin/issues/${sourceIssueId}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ targetIssueId }),
    },
  );
  return handleMerge(request, env, sourceIssueId, options.clientAddress ?? ALLOWED_IP);
}

describe("handleMerge (POST /api/admin/issues/:issueId/merge)", () => {
  it("returns 401 when the Authorization header is missing", async () => {
    const owner = await insertMember("t1");
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner);
      targetId = await insertIssue(owner);
      const res = await callMerge(testEnv(), sourceId, targetId, { token: null });
      expect(res.status).toBe(401);
    } finally {
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
    }
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const owner = await insertMember("t1");
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner);
      targetId = await insertIssue(owner);
      const res = await callMerge(testEnv(), sourceId, targetId, { token: "wrong-token" });
      expect(res.status).toBe(401);
    } finally {
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
    }
  });

  it("returns 401 when the token is correct but the caller's IP is not allow-listed", async () => {
    const owner = await insertMember("t1");
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner);
      targetId = await insertIssue(owner);
      const res = await callMerge(testEnv(), sourceId, targetId, {
        clientAddress: NOT_ALLOWED_IP,
      });
      expect(res.status).toBe(401);
    } finally {
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
    }
  });

  it("returns 404 when the source issue does not exist", async () => {
    const owner = await insertMember("t1");
    let targetId: string | undefined;
    try {
      targetId = await insertIssue(owner);
      const res = await callMerge(testEnv(), randomUUID(), targetId);
      expect(res.status).toBe(404);
    } finally {
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
    }
  });

  it("returns 404 when the target issue does not exist", async () => {
    const owner = await insertMember("t1");
    let sourceId: string | undefined;
    try {
      sourceId = await insertIssue(owner);
      const res = await callMerge(testEnv(), sourceId, randomUUID());
      expect(res.status).toBe(404);
    } finally {
      if (sourceId) await deleteIssue(sourceId);
      await deleteMember(owner);
    }
  });

  it("returns 400 when targetIssueId equals the source issueId (self-merge would silently wipe its own support data)", async () => {
    const owner = await insertMember("t1");
    const supporter = await insertMember("t2");
    let sourceId: string | undefined;
    try {
      sourceId = await insertIssue(owner, { status: "published" });
      await insertIssueSupport(sourceId, supporter);

      const res = await callMerge(testEnv(), sourceId, sourceId);
      expect(res.status).toBe(400);

      // The guard must reject before the transaction runs — the issue's own
      // support data and status must be untouched.
      const rows = await getIssueSupportRowsFor([sourceId], supporter);
      expect(rows).toHaveLength(1);
      const issueAfter = await getIssue(sourceId);
      expect(issueAfter?.status).toBe("published");
    } finally {
      await deleteIssueSupportFor([sourceId as string]);
      if (sourceId) await deleteIssue(sourceId);
      await deleteMember(owner);
      await deleteMember(supporter);
    }
  });

  it("unique(issue, member) constraint test: a member who already supports both source and target ends up with exactly one issue_support row, pointing at target, no constraint violation", async () => {
    const owner = await insertMember("t1");
    const member = await insertMember("t2");
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner, { status: "published" });
      targetId = await insertIssue(owner, { status: "published" });
      await insertIssueSupport(sourceId, member);
      await insertIssueSupport(targetId, member);

      const res = await callMerge(testEnv(), sourceId, targetId);
      expect(res.status).toBe(200);

      const rows = await getIssueSupportRowsFor([sourceId, targetId], member);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.issueId).toBe(targetId);
    } finally {
      if (sourceId && targetId) await deleteIssueSupportFor([sourceId, targetId]);
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
      await deleteMember(member);
    }
  });

  it("merge preserves both threads' history: source row survives as status='merged'/mergedInto=target, target survives unchanged, and target's supportT2Count reflects the pooled deduplicated total", async () => {
    const owner = await insertMember("t1");
    const memberA = await insertMember("t2"); // supports both source and target (overlap)
    const memberB = await insertMember("t2"); // supports only source
    const memberC = await insertMember("t2"); // supports only target
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner, { status: "published" });
      targetId = await insertIssue(owner, { status: "published" });

      await insertIssueSupport(sourceId, memberA);
      await insertIssueSupport(sourceId, memberB);
      await insertIssueSupport(targetId, memberA);
      await insertIssueSupport(targetId, memberC);

      const res = await callMerge(testEnv(), sourceId, targetId);
      expect(res.status).toBe(200);

      const sourceAfter = await getIssue(sourceId);
      expect(sourceAfter).toBeTruthy();
      expect(sourceAfter?.status).toBe("merged");
      expect(sourceAfter?.mergedInto).toBe(targetId);

      const targetAfter = await getIssue(targetId);
      expect(targetAfter).toBeTruthy();
      expect(targetAfter?.status).toBe("published");
      // Pooled dedup total: memberA (pre-existing on target), memberB
      // (re-pointed from source), memberC (pre-existing on target) = 3
      // unique supporters — NOT 4 (memberA must not be double-counted).
      expect(targetAfter?.supportT2Count).toBe(3);
    } finally {
      if (sourceId && targetId) await deleteIssueSupportFor([sourceId, targetId]);
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
      await deleteMember(memberA);
      await deleteMember(memberB);
      await deleteMember(memberC);
    }
  });

  it("returns 200 on the happy path", async () => {
    const owner = await insertMember("t1");
    let sourceId: string | undefined;
    let targetId: string | undefined;
    try {
      sourceId = await insertIssue(owner, { status: "published" });
      targetId = await insertIssue(owner, { status: "published" });

      const res = await callMerge(testEnv(), sourceId, targetId);
      expect(res.status).toBe(200);
    } finally {
      if (sourceId) await deleteIssue(sourceId);
      if (targetId) await deleteIssue(targetId);
      await deleteMember(owner);
    }
  });
});
