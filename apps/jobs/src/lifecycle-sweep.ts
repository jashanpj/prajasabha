import { schema } from "db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  type StatementTally,
  assertValidDeliberationTransition,
  computeConsensus,
  generateDeliberationSummaryPdf,
} from "shared";

// Issue #35 — C3 Deliberation Lifecycle. The only mutator of deliberation
// state in this phase — apps/jobs' scheduled() (index.ts) is a thin
// wrapper around this exported, directly-testable function, same split as
// apps/web/src/pages/api/issues/[issueId]/support.ts's handleSupport/POST.
//
// One sweep pass does BOTH transitions back-to-back (Open/Extended->Closed,
// then Closed->Summarized) so a deliberation that crosses its closesAt on
// a given day is fully summarized (PDF generated, artifact stored) by the
// end of that same run — matching todo.md's demo arc ("vote -> see
// consensus"), not a day later.
//
// Summarization computes the real "Broad agreement" set (issue #34) from
// statement_votes at the moment a deliberation closes — see the tally/
// computeConsensus block below.

// A minimal structural subset of Cloudflare's R2Bucket — enough for this
// module's one write, real in production (env.DELIBERATION_ARTIFACTS),
// fakeable with a plain in-memory object in tests.
export interface ArtifactStore {
  put(key: string, bytes: Uint8Array): Promise<unknown>;
}

export interface LifecycleSweepConfig {
  agreementThresholdPercent: number;
  minVoters: number;
}

export interface LifecycleSweepResult {
  closed: string[]; // deliberationIds transitioned open/extended -> closed this pass
  summarized: string[]; // deliberationIds transitioned closed -> summarized this pass
}

// biome-ignore lint/suspicious/noExplicitAny: drizzle's node-postgres db client type, matches getServiceRoleDb's own inferred return type
type DbClient = any;

function artifactKeyFor(deliberationId: string): string {
  return `deliberations/${deliberationId}/summary.pdf`;
}

export async function runDeliberationLifecycleSweep(
  db: DbClient,
  artifacts: ArtifactStore,
  config: LifecycleSweepConfig,
): Promise<LifecycleSweepResult> {
  // Sanity-checks the two hardcoded transitions below against the state
  // machine (packages/shared/src/deliberation-lifecycle.ts) — defense in
  // depth documentation, not a per-row runtime guard (the SQL WHERE
  // clauses below are the actual guard, same CAS idiom as
  // issues.promotedAt in support.ts).
  assertValidDeliberationTransition("open", "closed");
  assertValidDeliberationTransition("extended", "closed");
  assertValidDeliberationTransition("closed", "summarized");

  const closed: string[] = [];
  await db.transaction(async (tx: DbClient) => {
    const dueToClose = await tx
      .update(schema.deliberations)
      .set({ state: "closed", closedAt: sql`now()` })
      .where(
        and(
          inArray(schema.deliberations.state, ["open", "extended"]),
          lte(schema.deliberations.closesAt, sql`now()`),
        ),
      )
      .returning({
        deliberationId: schema.deliberations.deliberationId,
        issueId: schema.deliberations.issueId,
      });

    for (const row of dueToClose) {
      await tx.insert(schema.eventLog).values({
        kind: "deliberation_closed",
        subjectType: "issue",
        subjectId: row.issueId,
        payload: {},
      });
      closed.push(row.deliberationId);
    }
  });

  const dueToSummarize = await db
    .select({
      deliberationId: schema.deliberations.deliberationId,
      issueId: schema.deliberations.issueId,
      openedAt: schema.deliberations.openedAt,
      closedAt: schema.deliberations.closedAt,
      issueTitleEn: schema.issues.titleEn,
    })
    .from(schema.deliberations)
    .innerJoin(schema.issues, eq(schema.issues.issueId, schema.deliberations.issueId))
    .where(eq(schema.deliberations.state, "closed"));

  const summarized: string[] = [];
  if (dueToSummarize.length > 0) {
    const [{ totalT2Count }] = await db
      .select({ totalT2Count: sql<number>`count(*)::int` })
      .from(schema.members)
      .where(eq(schema.members.tier, "t2"));

    for (const deliberation of dueToSummarize) {
      // Issue #34 — C2 Consensus Surface. Only approved statements count;
      // pending/rejected ones never entered the vote pool at all (see
      // statements/next.ts's own status='approved' filter). Aggregated in
      // application code rather than a SQL pivot — pilot scale is small,
      // and this keeps computeConsensus (packages/shared) as the single
      // source of truth for the actual math on both sides (this cron sweep
      // and apps/web's live consensus page).
      const approvedStatements: { statementId: string; body: string }[] = await db
        .select({ statementId: schema.statements.statementId, body: schema.statements.body })
        .from(schema.statements)
        .where(
          and(
            eq(schema.statements.deliberationId, deliberation.deliberationId),
            eq(schema.statements.status, "approved"),
          ),
        );

      const votes: { statementId: string; vote: "agree" | "disagree" | "pass" }[] = await db
        .select({
          statementId: schema.statementVotes.statementId,
          vote: schema.statementVotes.vote,
        })
        .from(schema.statementVotes)
        .innerJoin(
          schema.statements,
          eq(schema.statements.statementId, schema.statementVotes.statementId),
        )
        .where(
          and(
            eq(schema.statements.deliberationId, deliberation.deliberationId),
            eq(schema.statements.status, "approved"),
          ),
        );

      const talliesByStatementId = new Map<string, StatementTally>(
        approvedStatements.map((s) => [
          s.statementId,
          { statementId: s.statementId, body: s.body, agree: 0, disagree: 0, pass: 0 },
        ]),
      );
      for (const v of votes) {
        const tally = talliesByStatementId.get(v.statementId);
        if (tally) tally[v.vote] += 1;
      }

      const consensusResults = computeConsensus([...talliesByStatementId.values()], {
        agreementThresholdPercent: config.agreementThresholdPercent,
        minVoters: config.minVoters,
      });
      const broadAgreement = consensusResults
        .filter((r) => r.meetsThreshold)
        .map((r) => ({
          statementId: r.statementId,
          body: r.body,
          agreePercent: r.agreePercent,
          sampleSize: r.sampleSize,
        }));

      const pdfBytes = await generateDeliberationSummaryPdf({
        issueTitleEn: deliberation.issueTitleEn,
        openedAt: deliberation.openedAt,
        closedAt: deliberation.closedAt ?? new Date(),
        totalT2Count,
        consensusStatements: broadAgreement,
        agreementThresholdPercent: config.agreementThresholdPercent,
        minVoters: config.minVoters,
        generatedAt: new Date(),
      });

      const artifactKey = artifactKeyFor(deliberation.deliberationId);
      await artifacts.put(artifactKey, pdfBytes);

      const summarizedNow = await db.transaction(async (tx: DbClient) => {
        const [updated] = await tx
          .update(schema.deliberations)
          .set({ state: "summarized", summarizedAt: sql`now()`, summaryArtifactKey: artifactKey })
          .where(
            and(
              eq(schema.deliberations.deliberationId, deliberation.deliberationId),
              eq(schema.deliberations.state, "closed"),
            ),
          )
          .returning({ deliberationId: schema.deliberations.deliberationId });

        if (updated) {
          await tx.insert(schema.eventLog).values({
            kind: "deliberation_summarized",
            subjectType: "issue",
            subjectId: deliberation.issueId,
            payload: { summaryArtifactKey: artifactKey },
          });
        }
        return Boolean(updated);
      });

      if (summarizedNow) summarized.push(deliberation.deliberationId);
    }
  }

  return { closed, summarized };
}
