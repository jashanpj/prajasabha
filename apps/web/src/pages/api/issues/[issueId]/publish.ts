import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  issueCreateSchema,
  loadIssueCategoriesConfig,
  loadIssuePublishRateLimitConfig,
  loadPilotWardsConfig,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";
import { computeRouting } from "../../../../lib/router";

// B1 — publish a draft (issue #24). Same 401/404/403 guards as draft.ts,
// plus 409 if the issue is past draft already. There is NO new request
// body: publish re-reads what autosave already persisted and re-validates
// it server-side —
//   1. the full issueCreateSchema shape (non-empty titles/body/category,
//      uuid wardId), and
//   2. category ∈ loadIssueCategoriesConfig and wardId ∈
//      loadPilotWardsConfig — the config-driven allow-lists (CLAUDE.md
//      invariant 6: lists live in env, not code),
// returning 422 validation_failed otherwise. The client's own disabled
// submit button is UX, not enforcement. No tier re-check: create.ts gated
// t1+ and tiers are monotonic. On success the throwaway draft-{uuid} slug
// is replaced with a title-derived one (suffixed with the issue id's first
// 8 chars, so two "Broken streetlight" issues never collide) and status
// flips to 'published' — the one transition that makes an issue publicly
// readable.

function slugify(title: string, issueId: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "issue"}-${issueId.slice(0, 8)}`;
}

export async function handlePublish(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { issuePublishRateLimitPerMemberPerHour } = loadIssuePublishRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:issue-publish:member:${session.memberId}:${hourBucket()}`,
    issuePublishRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [issue] = await db
    .select({
      createdBy: schema.issues.createdBy,
      status: schema.issues.status,
      titleMl: schema.issues.titleMl,
      titleEn: schema.issues.titleEn,
      body: schema.issues.body,
      category: schema.issues.category,
      wardId: schema.issues.wardId,
    })
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

  const shape = issueCreateSchema.safeParse({
    titleMl: issue.titleMl,
    titleEn: issue.titleEn,
    body: issue.body,
    category: issue.category,
    wardId: issue.wardId,
  });
  if (!shape.success) {
    return Response.json({ error: "validation_failed" }, { status: 422 });
  }

  const configEnv = env as unknown as Record<string, string | undefined>;
  const { issueCategories } = loadIssueCategoriesConfig(configEnv);
  const { pilotWards } = loadPilotWardsConfig(configEnv);

  if (!issueCategories.includes(shape.data.category)) {
    return Response.json({ error: "validation_failed" }, { status: 422 });
  }
  if (!pilotWards.some((ward) => ward.id === shape.data.wardId)) {
    return Response.json({ error: "validation_failed" }, { status: 422 });
  }

  const slug = slugify(shape.data.titleEn, issueId);
  await db
    .update(schema.issues)
    .set({ status: "published", slug })
    .where(eq(schema.issues.issueId, issueId));

  // B2 — Responsibility Router (issue #25). Routing is computed once, at
  // publish time, not on-the-fly at render time — see the approved plan's
  // rationale (a per-issue audit trail; later rules-table edits don't
  // silently reroute already-published issues). No match is a valid
  // outcome (a "not yet routed" issue), not a publish-blocking error.
  const routings = await computeRouting(db, {
    category: shape.data.category,
    wardId: shape.data.wardId,
  });
  if (routings.length > 0) {
    await db.insert(schema.routings).values(
      routings.map((routing) => ({
        issueId,
        authorityId: routing.authorityId,
        role: routing.role,
        legalBasisRef: routing.legalBasisRef,
      })),
    );
  }

  return Response.json({ slug });
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
  return handlePublish(request, env, issueId);
};
