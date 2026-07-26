import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  loadStatementSubmitRateLimitConfig,
  statementCreateSchema,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

// C1 — Statement Submission (issue #33). Any T2 member can submit a
// statement on a Concern's deliberation while it's Open or Extended — no
// ownership/ordering guard beyond that (unlike issue #24's draft-owner
// checks; there is no "own draft" concept here). Guard order mirrors the
// sibling B-module endpoints: 401 no session -> 429 rate limit -> 404
// unknown deliberation -> 403 not T2 -> 409 deliberation not open/extended
// -> 400 Zod (>280 chars). Starts life as status='pending' — the
// moderation queue Module H (issue #29) doesn't have a real console yet,
// so only approved statements are ever servable (see statements/next.ts);
// a minimal admin-gated endpoint flips status until #29 lands
// (POST /api/admin/statements/:statementId/moderate).
export async function handleStatementCreate(
  request: Request,
  env: Cloudflare.Env,
  deliberationId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { statementSubmitRateLimitPerMemberPerHour } = loadStatementSubmitRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:statement-create:member:${session.memberId}:${hourBucket()}`,
    statementSubmitRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  // Joined to issues.status, not just the deliberation row: a security
  // review caught that the service-role connection here bypasses RLS, so
  // without this join a merged/closed issue's deliberation (which
  // statements_public_read's RLS policy already hides — migration 0010)
  // would still accept new statements through this endpoint. Same gate,
  // enforced in application code where RLS can't reach.
  const [deliberation] = await db
    .select({ state: schema.deliberations.state, issueStatus: schema.issues.status })
    .from(schema.deliberations)
    .innerJoin(schema.issues, eq(schema.issues.issueId, schema.deliberations.issueId))
    .where(eq(schema.deliberations.deliberationId, deliberationId))
    .limit(1);

  if (!deliberation || deliberation.issueStatus !== "published") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const [member] = await db
    .select({ tier: schema.members.tier })
    .from(schema.members)
    .where(eq(schema.members.memberId, session.memberId))
    .limit(1);

  if (!member || member.tier !== "t2") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (deliberation.state !== "open" && deliberation.state !== "extended") {
    return Response.json({ error: "deliberation_not_open" }, { status: 409 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = statementCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const [inserted] = await db
    .insert(schema.statements)
    .values({
      deliberationId,
      authorMemberId: session.memberId,
      body: parsed.data.body,
    })
    .returning({ statementId: schema.statements.statementId });

  if (!inserted) {
    return Response.json({ error: "create_failed" }, { status: 500 });
  }

  return Response.json({ statementId: inserted.statementId }, { status: 201 });
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
  const deliberationId = params.deliberationId;
  if (!deliberationId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleStatementCreate(request, env, deliberationId);
};
