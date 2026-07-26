import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  loadStatementVoteRateLimitConfig,
  statementVoteActionSchema,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

const POSTGRES_UNIQUE_VIOLATION = "23505";

// Same wrapped-error-code check as support.ts's isUniqueViolation — see
// that file's comment for why both .code and .cause.code are checked.
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === POSTGRES_UNIQUE_VIOLATION || causeCode === POSTGRES_UNIQUE_VIOLATION;
}

// C1 — Agree/Disagree/Pass voting (issue #33). Guard order: 401 no session
// -> 429 rate limit -> 404 unknown/not-yet-approved statement -> 409
// parent deliberation closed/summarized (voting only makes sense while
// open/extended) -> 403 own-statement ("own statements are not votable by
// their author" — the AC's own text) -> insert. "One vote per statement
// per user" is enforced by statement_votes' real
// unique(statement_id, member_id) constraint, not a pre-check SELECT (same
// dedup precedent as issue_support), with the genuine 23505 unique-
// violation translated to a 409 {error: "already_voted"}.
export async function handleStatementVote(
  request: Request,
  env: Cloudflare.Env,
  statementId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { statementVoteRateLimitPerMemberPerHour } = loadStatementVoteRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:statement-vote:member:${session.memberId}:${hourBucket()}`,
    statementVoteRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [statement] = await db
    .select({
      authorMemberId: schema.statements.authorMemberId,
      status: schema.statements.status,
      deliberationId: schema.statements.deliberationId,
    })
    .from(schema.statements)
    .where(eq(schema.statements.statementId, statementId))
    .limit(1);

  if (!statement || statement.status !== "approved") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Joined to issues.status — same security-review fix as statements.ts
  // and next.ts: the service-role connection bypasses RLS, so a
  // merged/closed issue's deliberation (already hidden by
  // statements_public_read's RLS policy) must also stop accepting votes
  // through this endpoint, not just newly-invisible reads.
  const [deliberation] = await db
    .select({ state: schema.deliberations.state, issueStatus: schema.issues.status })
    .from(schema.deliberations)
    .innerJoin(schema.issues, eq(schema.issues.issueId, schema.deliberations.issueId))
    .where(eq(schema.deliberations.deliberationId, statement.deliberationId))
    .limit(1);

  if (!deliberation || deliberation.issueStatus !== "published") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (deliberation.state !== "open" && deliberation.state !== "extended") {
    return Response.json({ error: "deliberation_not_open" }, { status: 409 });
  }

  if (statement.authorMemberId === session.memberId) {
    return Response.json({ error: "cannot_vote_own_statement" }, { status: 403 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = statementVoteActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await db.insert(schema.statementVotes).values({
      statementId,
      memberId: session.memberId,
      vote: parsed.data.vote,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return Response.json({ error: "already_voted" }, { status: 409 });
    }
    throw error;
  }

  return Response.json({ ok: true }, { status: 201 });
}

function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

export const POST: APIRoute = async ({ request, params }) => {
  const statementId = params.statementId;
  if (!statementId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleStatementVote(request, env, statementId);
};
