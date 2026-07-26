import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  issueDraftUpdateSchema,
  loadIssueDraftRateLimitConfig,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

// B1 — debounced autosave PATCH (issue #24). The client calls this ~800ms
// after the last keystroke; the body is any partial of issueCreateSchema
// (issueDraftUpdateSchema), and only the fields present are written.
// Guard order: 401 no session → 404 unknown issue → 403 not the creator →
// 409 no longer a draft. No tier re-check: create.ts already gated t1+,
// and tiers are monotonic — a member can't be demoted below the tier that
// created the draft. Ownership, not tier, is the invariant here.

export async function handleDraftUpdate(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { issueDraftRateLimitPerMemberPerHour } = loadIssueDraftRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:issue-draft:member:${session.memberId}:${hourBucket()}`,
    issueDraftRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [issue] = await db
    .select({ createdBy: schema.issues.createdBy, status: schema.issues.status })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, issueId))
    .limit(1);

  if (!issue) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (issue.createdBy !== session.memberId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (issue.status !== "draft") {
    return Response.json({ error: "not_a_draft" }, { status: 409 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = issueDraftUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  // Drizzle's .set({}) throws on an empty object — an empty autosave tick
  // is a valid no-op, so skip the UPDATE entirely rather than erroring.
  if (Object.keys(parsed.data).length > 0) {
    await db.update(schema.issues).set(parsed.data).where(eq(schema.issues.issueId, issueId));
  }

  return Response.json({ ok: true });
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

export const PATCH: APIRoute = async ({ request, params }) => {
  const issueId = params.issueId;
  if (!issueId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleDraftUpdate(request, env, issueId);
};
