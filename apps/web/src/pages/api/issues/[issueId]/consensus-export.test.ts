import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { handleConsensusExport } from "./consensus-export";

// Issue #34 (C2 — Consensus Surface). Public endpoint, no session — same
// real-Postgres, single-shared-client-per-file convention as every other
// endpoint test in this codebase.

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

function fakeArtifactBucket(store: Map<string, string>) {
  return {
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return { body } as unknown as R2ObjectBody;
    },
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    DELIBERATION_ARTIFACTS: fakeArtifactBucket(new Map()),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function insertMember(): Promise<string> {
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `consensus-export-${randomUUID().slice(0, 8)}`, tier: "t1", locale: "ml" })
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
      slug: `consensus-export-test-${randomUUID().slice(0, 8)}`,
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

async function setIssueStatus(
  issueId: string,
  status: "published" | "closed" | "merged",
): Promise<void> {
  await db.update(schema.issues).set({ status }).where(eq(schema.issues.issueId, issueId));
}

async function insertDeliberation(
  issueId: string,
  overrides: Partial<{
    state: "open" | "extended" | "closed" | "summarized";
    summaryArtifactKey: string | null;
  }> = {},
): Promise<string> {
  const [inserted] = await db
    .insert(schema.deliberations)
    .values({
      issueId,
      state: overrides.state ?? "open",
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      summaryArtifactKey: overrides.summaryArtifactKey ?? null,
    })
    .returning({ deliberationId: schema.deliberations.deliberationId });
  if (!inserted) throw new Error("deliberation insert returned no row");
  return inserted.deliberationId;
}

async function deleteDeliberation(deliberationId: string): Promise<void> {
  await db
    .delete(schema.deliberations)
    .where(eq(schema.deliberations.deliberationId, deliberationId));
}

describe("handleConsensusExport (GET /api/issues/:issueId/consensus-export)", () => {
  it("returns 404 when the issue does not exist", async () => {
    const res = await handleConsensusExport(testEnv(), randomUUID());
    expect(res.status).toBe(404);
  });

  it("returns 404 when the issue has no deliberation", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const res = await handleConsensusExport(testEnv(), issueId);
      expect(res.status).toBe(404);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 409 not_yet_summarized when the deliberation is still open", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, { state: "open" });
      const res = await handleConsensusExport(testEnv(), issueId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "not_yet_summarized" });
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 409 not_yet_summarized when the deliberation is closed but not yet summarized", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, { state: "closed" });
      const res = await handleConsensusExport(testEnv(), issueId);
      expect(res.status).toBe(409);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 404 artifact_missing if summarized but the R2 object is somehow absent", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "summarized",
        summaryArtifactKey: `deliberations/${randomUUID()}/summary.pdf`,
      });
      const res = await handleConsensusExport(testEnv(), issueId);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "artifact_missing" });
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 200 with the PDF body and content-type when summarized", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const artifactKey = `deliberations/${randomUUID()}/summary.pdf`;
      deliberationId = await insertDeliberation(issueId, {
        state: "summarized",
        summaryArtifactKey: artifactKey,
      });

      const store = new Map([[artifactKey, "%PDF-fake-bytes"]]);
      const res = await handleConsensusExport(
        testEnv({ DELIBERATION_ARTIFACTS: fakeArtifactBucket(store) }),
        issueId,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(await res.text()).toBe("%PDF-fake-bytes");
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  // Security-review regression (issue #34) — same authz-parity gate as
  // statements.ts/next.ts/vote.ts: a closed issue must stop serving its
  // consensus artifact too, not just via the deliberation's own state.
  it("returns 404 when the issue itself has been closed, even though the deliberation is summarized", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const artifactKey = `deliberations/${randomUUID()}/summary.pdf`;
      deliberationId = await insertDeliberation(issueId, {
        state: "summarized",
        summaryArtifactKey: artifactKey,
      });
      await setIssueStatus(issueId, "closed");

      const store = new Map([[artifactKey, "%PDF-fake-bytes"]]);
      const res = await handleConsensusExport(
        testEnv({ DELIBERATION_ARTIFACTS: fakeArtifactBucket(store) }),
        issueId,
      );
      expect(res.status).toBe(404);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("still serves the artifact when the issue has been merged (matches the page's own visibility gate)", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const artifactKey = `deliberations/${randomUUID()}/summary.pdf`;
      deliberationId = await insertDeliberation(issueId, {
        state: "summarized",
        summaryArtifactKey: artifactKey,
      });
      await setIssueStatus(issueId, "merged");

      const store = new Map([[artifactKey, "%PDF-fake-bytes"]]);
      const res = await handleConsensusExport(
        testEnv({ DELIBERATION_ARTIFACTS: fakeArtifactBucket(store) }),
        issueId,
      );
      expect(res.status).toBe(200);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });
});
