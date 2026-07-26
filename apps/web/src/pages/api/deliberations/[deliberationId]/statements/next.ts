import type { APIRoute } from "astro";
import { schema } from "db";
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { verifySession } from "shared";
import { getServiceRoleDb } from "../../../../../lib/db";

// C1 — randomized statement serving (issue #33): "randomized serving; no
// replies, no threads." Excludes the caller's own statements ("own
// statements are not votable by their author" — the AC's own text) and
// anything they've already voted on (no re-serving a statement just voted
// on). The participation counter ("Statement N of M") is "always visible"
// per the AC regardless of whether any statement remains to serve, so it's
// computed and returned even in the {done:true} case.
export async function handleNextStatement(
  request: Request,
  env: Cloudflare.Env,
  deliberationId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  // Joined to issues.status — same security-review fix as statements.ts:
  // the service-role connection bypasses RLS, so a merged/closed issue's
  // deliberation (already hidden by statements_public_read's RLS policy)
  // must also stop serving statements through this endpoint.
  const [deliberation] = await db
    .select({
      deliberationId: schema.deliberations.deliberationId,
      issueStatus: schema.issues.status,
    })
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

  const [{ totalApproved }] = await db
    .select({ totalApproved: sql<number>`count(*)::int` })
    .from(schema.statements)
    .where(
      and(
        eq(schema.statements.deliberationId, deliberationId),
        eq(schema.statements.status, "approved"),
      ),
    );

  const myVotedStatementIds = db
    .select({ statementId: schema.statementVotes.statementId })
    .from(schema.statementVotes)
    .where(eq(schema.statementVotes.memberId, session.memberId));

  const [{ votedCount }] = await db
    .select({ votedCount: sql<number>`count(*)::int` })
    .from(schema.statementVotes)
    .innerJoin(
      schema.statements,
      eq(schema.statements.statementId, schema.statementVotes.statementId),
    )
    .where(
      and(
        eq(schema.statements.deliberationId, deliberationId),
        eq(schema.statementVotes.memberId, session.memberId),
      ),
    );

  const [next] = await db
    .select({ statementId: schema.statements.statementId, body: schema.statements.body })
    .from(schema.statements)
    .where(
      and(
        eq(schema.statements.deliberationId, deliberationId),
        eq(schema.statements.status, "approved"),
        ne(schema.statements.authorMemberId, session.memberId),
        notInArray(schema.statements.statementId, myVotedStatementIds),
      ),
    )
    .orderBy(sql`random()`)
    .limit(1);

  if (!next) {
    return Response.json(
      { done: true, position: votedCount, total: totalApproved },
      { status: 200 },
    );
  }

  return Response.json(
    {
      done: false,
      statement: { statementId: next.statementId, body: next.body },
      position: votedCount + 1,
      total: totalApproved,
    },
    { status: 200 },
  );
}

function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export const GET: APIRoute = async ({ request, params }) => {
  const deliberationId = params.deliberationId;
  if (!deliberationId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleNextStatement(request, env, deliberationId);
};
