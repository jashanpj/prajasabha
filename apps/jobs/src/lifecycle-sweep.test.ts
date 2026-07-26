import { randomUUID } from "node:crypto";
import { createDbClient, schema } from "db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type ArtifactStore, runDeliberationLifecycleSweep } from "./lifecycle-sweep";

// Issue #35 (C3 Deliberation Lifecycle). Same real-Postgres-via-
// APP_DATABASE_URL convention as every apps/web endpoint test, and same
// single-shared-client-per-file fix support.test.ts needed (issue #35's own
// PR) — one pg Pool for the whole file, not one per helper call.

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

const CONFIG = { agreementThresholdPercent: 70, minVoters: 30 };

function fakeArtifactStore(): ArtifactStore & { puts: Map<string, Uint8Array> } {
  const puts = new Map<string, Uint8Array>();
  return {
    puts,
    async put(key: string, bytes: Uint8Array) {
      puts.set(key, bytes);
    },
  };
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t2"): Promise<string> {
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `lifecycle-sweep-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
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
      slug: `lifecycle-sweep-test-${randomUUID().slice(0, 8)}`,
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
  overrides: Partial<{
    state: "open" | "extended" | "closed" | "summarized";
    closesAt: Date;
  }> = {},
): Promise<string> {
  const [inserted] = await db
    .insert(schema.deliberations)
    .values({
      issueId,
      state: overrides.state ?? "open",
      closesAt: overrides.closesAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
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

async function getDeliberation(deliberationId: string) {
  const [row] = await db
    .select()
    .from(schema.deliberations)
    .where(eq(schema.deliberations.deliberationId, deliberationId));
  return row;
}

async function getEventLogRows(issueId: string, kind: string) {
  return db
    .select()
    .from(schema.eventLog)
    .where(and(eq(schema.eventLog.subjectId, issueId), eq(schema.eventLog.kind, kind)));
}

describe("runDeliberationLifecycleSweep (C3 — issue #35)", () => {
  it("does not transition a deliberation whose closesAt is in the future", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const result = await runDeliberationLifecycleSweep(db, fakeArtifactStore(), CONFIG);

      expect(result.closed).not.toContain(deliberationId);
      const after = await getDeliberation(deliberationId);
      expect(after?.state).toBe("open");
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("closes an open deliberation past its closesAt and logs deliberation_closed", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "open",
        closesAt: new Date(Date.now() - 60 * 1000),
      });

      const result = await runDeliberationLifecycleSweep(db, fakeArtifactStore(), CONFIG);

      expect(result.closed).toContain(deliberationId);
      const after = await getDeliberation(deliberationId);
      expect(after?.state).toBe("summarized"); // same pass also summarizes — see below test
      expect(after?.closedAt).not.toBeNull();

      const rows = await getEventLogRows(issueId, "deliberation_closed");
      expect(rows).toHaveLength(1);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("closes an extended deliberation past its closesAt", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "extended",
        closesAt: new Date(Date.now() - 60 * 1000),
      });

      const result = await runDeliberationLifecycleSweep(db, fakeArtifactStore(), CONFIG);

      expect(result.closed).toContain(deliberationId);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("summarizes a closed deliberation with zero statements: well-formed PDF, artifact key set, event logged", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "closed",
        closesAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const artifacts = fakeArtifactStore();
      const result = await runDeliberationLifecycleSweep(db, artifacts, CONFIG);

      expect(result.summarized).toContain(deliberationId);
      const after = await getDeliberation(deliberationId);
      expect(after?.state).toBe("summarized");
      expect(after?.summarizedAt).not.toBeNull();
      expect(after?.summaryArtifactKey).toBe(`deliberations/${deliberationId}/summary.pdf`);

      const pdfBytes = artifacts.puts.get(after?.summaryArtifactKey ?? "");
      expect(pdfBytes).toBeDefined();
      expect(new TextDecoder().decode(pdfBytes?.slice(0, 5))).toBe("%PDF-");

      const rows = await getEventLogRows(issueId, "deliberation_summarized");
      expect(rows).toHaveLength(1);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("does not re-summarize an already-summarized deliberation", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, { state: "summarized" });

      const result = await runDeliberationLifecycleSweep(db, fakeArtifactStore(), CONFIG);

      expect(result.summarized).not.toContain(deliberationId);
      const rows = await getEventLogRows(issueId, "deliberation_summarized");
      expect(rows).toHaveLength(0);
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("closes and summarizes a deliberation that crosses closesAt in the same pass", async () => {
    const memberId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "open",
        closesAt: new Date(Date.now() - 60 * 1000),
      });

      const result = await runDeliberationLifecycleSweep(db, fakeArtifactStore(), CONFIG);

      expect(result.closed).toContain(deliberationId);
      expect(result.summarized).toContain(deliberationId);
      const after = await getDeliberation(deliberationId);
      expect(after?.state).toBe("summarized");
    } finally {
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });
});
