import type { APIRoute } from "astro";
import { schema } from "db";
import { eq, sql } from "drizzle-orm";
import { loadIssueMergeAdminConfig } from "shared";
import { requireAdminAccess } from "../../../../../lib/admin-auth";
import { getServiceRoleDb } from "../../../../../lib/db";

// B3 — admin-only issue merge (issue #26). Internal-ops-only: there is no
// admin-role model anywhere in this codebase yet, so this is gated the same
// bearer-token + IP-allowlist way apps/vault-svc/src/review-auth.ts's
// requireReviewAccess already gates `/review/epic/*` (see admin-auth.ts and
// loadIssueMergeAdminConfig). No session/cookie auth at all.
//
// `issueId` (route param) is the SOURCE issue being merged away; the request
// body's `targetIssueId` is the issue it's merged into. On success, in one
// transaction: issue_support rows pointing at source are re-pointed to
// target (an INSERT ... SELECT ... ON CONFLICT DO NOTHING against the
// existing unique(issue_id, member_id) constraint skips any member who
// already supports target, so nothing raises a duplicate/constraint
// violation), target's supportT2Count is recomputed as a fresh COUNT(*)
// (never incremented, to avoid double-counting an overlapping supporter),
// and source's own row is never deleted — status flips to 'merged' and
// mergedInto is set to target, so both issues' own history/pages stay
// reachable.
export async function handleMerge(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
  clientAddress: string,
): Promise<Response> {
  const { adminToken, ipAllowlist } = loadIssueMergeAdminConfig(
    env as unknown as Record<string, string | undefined>,
  );
  if (!requireAdminAccess(request, clientAddress, adminToken, ipAllowlist)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => undefined);
  const targetIssueId =
    rawBody && typeof rawBody === "object" && "targetIssueId" in rawBody
      ? (rawBody as { targetIssueId: unknown }).targetIssueId
      : undefined;
  if (typeof targetIssueId !== "string" || targetIssueId.length === 0) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  // A self-merge (target === source) would DELETE the issue's own
  // issue_support rows (re-pointing them to itself is a no-op under ON
  // CONFLICT DO NOTHING, then the cleanup DELETE removes them anyway),
  // silently zeroing supportT2Count and breaking "both threads' history
  // survives" for that issue — reject before the transaction starts.
  if (targetIssueId === issueId) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);

  const [sourceIssue] = await db
    .select({ issueId: schema.issues.issueId })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, issueId))
    .limit(1);
  if (!sourceIssue) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const [targetIssue] = await db
    .select({ issueId: schema.issues.issueId })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, targetIssueId))
    .limit(1);
  if (!targetIssue) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await db.transaction(async (tx) => {
    // Re-point source's supporters to target, skipping any member who
    // already supports target (ON CONFLICT DO NOTHING against
    // issue_support_issue_member_uniq) so no duplicate/constraint
    // violation is ever raised for an overlapping supporter.
    await tx.execute(sql`
      INSERT INTO issue_support (issue_id, member_id, ward_id, created_at)
      SELECT ${targetIssueId}, member_id, ward_id, created_at
      FROM issue_support
      WHERE issue_id = ${issueId}
      ON CONFLICT (issue_id, member_id) DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM issue_support WHERE issue_id = ${issueId}
    `);

    // Recompute target's supportT2Count as a fresh COUNT(*) — never an
    // increment — so an overlapping supporter is never double-counted.
    const countResult = await tx.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM issue_support WHERE issue_id = ${targetIssueId}
    `);
    const count = countResult.rows[0]?.count ?? 0;
    await tx
      .update(schema.issues)
      .set({ supportT2Count: count })
      .where(eq(schema.issues.issueId, targetIssueId));

    // Source's own row is never deleted — both threads' history stays
    // reachable.
    await tx
      .update(schema.issues)
      .set({ status: "merged", mergedInto: targetIssueId })
      .where(eq(schema.issues.issueId, issueId));

    // B5 — Issue Timeline (issue #28). No member session exists on this
    // internal-ops-only endpoint, so no actorMemberId (system-triggered,
    // same precedent as #27's promotion event).
    await tx.insert(schema.eventLog).values({
      kind: "issue_merged",
      subjectType: "issue",
      subjectId: issueId,
      payload: { targetIssueId },
    });
  });

  return Response.json({ ok: true }, { status: 200 });
}

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  const issueId = params.issueId;
  if (!issueId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleMerge(request, env, issueId, clientAddress);
};
