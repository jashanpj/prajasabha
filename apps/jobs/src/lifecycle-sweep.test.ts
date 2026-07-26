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

// Issue #34 (C2) helpers — statements/votes to exercise the real
// consensus-tally wiring in the summarization phase.
async function insertStatement(deliberationId: string, authorMemberId: string): Promise<string> {
  const [inserted] = await db
    .insert(schema.statements)
    .values({ deliberationId, authorMemberId, body: "a qualifying statement", status: "approved" })
    .returning({ statementId: schema.statements.statementId });
  if (!inserted) throw new Error("statement insert returned no row");
  return inserted.statementId;
}

async function insertVotes(
  statementId: string,
  votes: { vote: "agree" | "disagree" | "pass" }[],
): Promise<string[]> {
  const memberIds: string[] = [];
  for (const { vote } of votes) {
    const memberId = await insertMember();
    memberIds.push(memberId);
    await db.insert(schema.statementVotes).values({ statementId, memberId, vote });
  }
  return memberIds;
}

async function deleteStatement(statementId: string): Promise<void> {
  await db.delete(schema.statementVotes).where(eq(schema.statementVotes.statementId, statementId));
  await db.delete(schema.statements).where(eq(schema.statements.statementId, statementId));
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

  // Issue #34 (C2) — the real vote-tally wiring, replacing PR1's
  // empty-array stub. Both scenarios below use the same 30 voters (the
  // CONFIG's minVoters), same statement body text, differing only in
  // agree/disagree split — so a resulting PDF size difference is
  // attributable only to whether the statement's quote+percentage line
  // was included (meets threshold) or omitted (does not), not incidental
  // text-length differences.
  it("includes a statement that meets the broad-agreement threshold in the summary PDF", async () => {
    const memberId = await insertMember();
    const authorId = await insertMember();
    let issueId: string | undefined;
    let deliberationId: string | undefined;
    let statementId: string | undefined;
    const voterIds: string[] = [];
    try {
      issueId = await insertIssue(memberId);
      deliberationId = await insertDeliberation(issueId, {
        state: "closed",
        closesAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      statementId = await insertStatement(deliberationId, authorId);
      // 21/30 = 70% — exactly meets CONFIG's threshold.
      voterIds.push(
        ...(await insertVotes(statementId, [
          ...Array(21).fill({ vote: "agree" }),
          ...Array(9).fill({ vote: "disagree" }),
        ])),
      );

      const artifactsQualifying = fakeArtifactStore();
      await runDeliberationLifecycleSweep(db, artifactsQualifying, CONFIG);
      const after = await getDeliberation(deliberationId);
      const qualifyingPdf = artifactsQualifying.puts.get(after?.summaryArtifactKey ?? "");
      expect(qualifyingPdf).toBeDefined();
      expect(new TextDecoder().decode(qualifyingPdf?.slice(0, 5))).toBe("%PDF-");
    } finally {
      if (statementId) await deleteStatement(statementId);
      if (deliberationId) await deleteDeliberation(deliberationId);
      if (issueId) await deleteIssue(issueId);
      for (const voterId of voterIds) await deleteMember(voterId);
      await deleteMember(authorId);
      await deleteMember(memberId);
    }
  });

  it("excludes a statement that does not meet the broad-agreement threshold from the summary PDF", async () => {
    const ownerA = await insertMember();
    const ownerB = await insertMember();
    const authorA = await insertMember();
    const authorB = await insertMember();
    let issueIdA: string | undefined;
    let issueIdB: string | undefined;
    let deliberationIdA: string | undefined;
    let deliberationIdB: string | undefined;
    let statementIdA: string | undefined;
    let statementIdB: string | undefined;
    const voterIds: string[] = [];
    try {
      // A: meets the threshold (21/30 = 70%).
      issueIdA = await insertIssue(ownerA);
      deliberationIdA = await insertDeliberation(issueIdA, {
        state: "closed",
        closesAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      statementIdA = await insertStatement(deliberationIdA, authorA);
      voterIds.push(
        ...(await insertVotes(statementIdA, [
          ...Array(21).fill({ vote: "agree" }),
          ...Array(9).fill({ vote: "disagree" }),
        ])),
      );

      // B: does NOT meet the threshold (10/30 = 33%), same body text/length.
      issueIdB = await insertIssue(ownerB);
      deliberationIdB = await insertDeliberation(issueIdB, {
        state: "closed",
        closesAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      statementIdB = await insertStatement(deliberationIdB, authorB);
      voterIds.push(
        ...(await insertVotes(statementIdB, [
          ...Array(10).fill({ vote: "agree" }),
          ...Array(20).fill({ vote: "disagree" }),
        ])),
      );

      const artifacts = fakeArtifactStore();
      await runDeliberationLifecycleSweep(db, artifacts, CONFIG);

      const afterA = await getDeliberation(deliberationIdA);
      const afterB = await getDeliberation(deliberationIdB);
      const pdfA = artifacts.puts.get(afterA?.summaryArtifactKey ?? "");
      const pdfB = artifacts.puts.get(afterB?.summaryArtifactKey ?? "");
      expect(pdfA).toBeDefined();
      expect(pdfB).toBeDefined();

      // A includes the qualifying statement's quote + percentage line; B
      // omits its non-qualifying statement entirely — A must be larger.
      expect(pdfA?.byteLength ?? 0).toBeGreaterThan(pdfB?.byteLength ?? 0);
    } finally {
      if (statementIdA) await deleteStatement(statementIdA);
      if (statementIdB) await deleteStatement(statementIdB);
      if (deliberationIdA) await deleteDeliberation(deliberationIdA);
      if (deliberationIdB) await deleteDeliberation(deliberationIdB);
      if (issueIdA) await deleteIssue(issueIdA);
      if (issueIdB) await deleteIssue(issueIdB);
      for (const voterId of voterIds) await deleteMember(voterId);
      await deleteMember(authorA);
      await deleteMember(authorB);
      await deleteMember(ownerA);
      await deleteMember(ownerB);
    }
  });
});
