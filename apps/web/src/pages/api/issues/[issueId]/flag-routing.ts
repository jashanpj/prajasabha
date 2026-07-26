import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { checkAndIncrement, loadFlagRoutingRateLimitConfig, verifySession } from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

// B2 — Responsibility Router (issue #25). Any authenticated member (no
// tier gate, no ownership check) can flag a published issue's routing as
// wrong. There's no new "flags" table: this appends exactly one event_log
// row (append-only, per CLAUDE.md invariant 3) — the same pattern as the
// only other event_log write in this codebase
// (apps/web/src/pages/api/auth/register/verify.ts's
// registration_failed_after_token_consumed insert). That row IS the
// "routes to admin review" mechanism for this MVP — a human reviewer
// queries event_log for kind='issue_routing_flagged'; a dedicated admin
// review UI is out of scope here, same as routing_rules having no admin
// UI yet.

export async function handleFlagRouting(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { flagRoutingRateLimitPerMemberPerHour } = loadFlagRoutingRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:flag-routing:member:${session.memberId}:${hourBucket()}`,
    flagRoutingRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [issue] = await db
    .select({ status: schema.issues.status })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, issueId))
    .limit(1);

  if (!issue) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (issue.status === "draft") {
    return Response.json({ error: "still_draft" }, { status: 409 });
  }

  const rawBody = await request.json().catch(() => null);
  const note =
    rawBody && typeof rawBody === "object" && "note" in rawBody && typeof rawBody.note === "string"
      ? rawBody.note
      : null;

  await db.insert(schema.eventLog).values({
    actorMemberId: session.memberId,
    kind: "issue_routing_flagged",
    subjectType: "issue",
    subjectId: issueId,
    payload: { note },
  });

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
  const issueId = params.issueId;
  if (!issueId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleFlagRouting(request, env, issueId);
};
