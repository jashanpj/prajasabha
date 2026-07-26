import type { APIRoute } from "astro";
import { schema } from "db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  checkAndIncrement,
  loadConfig,
  loadIssueSupportRateLimitConfig,
  loadPilotWardsConfig,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

// B3 — Support & Dedup (issue #26). Any T2 member (not just the creator)
// can "Support" a published issue — no ownership check, unlike
// draft.ts/photos.ts/publish.ts. Guard order mirrors the sibling
// endpoints: 401 no session → rate limit → 404 unknown issue → 403 not T2
// → 409 still a draft → 400 wardId not in the pilot-ward allow-list.
// Dedup is enforced by issue_support's real unique(issue_id, member_id)
// constraint (packages/db/src/schema.ts), not a pre-check SELECT — a
// pre-check would race two concurrent supports from the same member. The
// insert's Postgres 23505 unique-violation is caught and translated to a
// 409 {error: "already_supported"} instead of a 500, and only a
// successful insert increments issues.supportT2Count.
//
// B4 — Constituency Concern threshold & promotion (issue #27): after the
// increment, an atomic compare-and-swap UPDATE checks whether
// supportT2Count has just crossed loadConfig().concernThresholdT2 and
// promotedAt is still unset; only then does a single
// issue_promoted_to_concern event_log row fire (see below).

const POSTGRES_UNIQUE_VIOLATION = "23505";

// node-postgres surfaces the unique-violation code as `.code` on the raw
// driver error, but drizzle-orm wraps that in a DrizzleQueryError whose own
// `.code` is undefined — the real code lives on `.cause.code`. Check both
// so this works whether or not a future drizzle version stops wrapping.
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === POSTGRES_UNIQUE_VIOLATION || causeCode === POSTGRES_UNIQUE_VIOLATION;
}

export async function handleSupport(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { issueSupportRateLimitPerMemberPerHour } = loadIssueSupportRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:issue-support:member:${session.memberId}:${hourBucket()}`,
    issueSupportRateLimitPerMemberPerHour,
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

  const [member] = await db
    .select({ tier: schema.members.tier })
    .from(schema.members)
    .where(eq(schema.members.memberId, session.memberId))
    .limit(1);

  if (!member || member.tier !== "t2") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (issue.status === "draft") {
    return Response.json({ error: "not_a_draft" }, { status: 409 });
  }

  const rawBody = await request.json().catch(() => null);
  const wardId =
    rawBody && typeof rawBody === "object" && "wardId" in rawBody
      ? (rawBody as { wardId: unknown }).wardId
      : undefined;
  if (typeof wardId !== "string") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const { pilotWards } = loadPilotWardsConfig(env as unknown as Record<string, string | undefined>);
  if (!pilotWards.some((ward) => ward.id === wardId)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await db.insert(schema.issueSupport).values({
      issueId,
      memberId: session.memberId,
      wardId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return Response.json({ error: "already_supported" }, { status: 409 });
    }
    throw error;
  }

  await db
    .update(schema.issues)
    .set({ supportT2Count: sql`${schema.issues.supportT2Count} + 1` })
    .where(eq(schema.issues.issueId, issueId));

  // B4 — Constituency Concern threshold & promotion (issue #27). The CAS
  // UPDATE only matches (and only then does the promotion event fire) if
  // promoted_at is still NULL AND the just-incremented count has crossed
  // the configured threshold. Postgres serializes concurrent UPDATEs on
  // the same row, so two supports crossing the threshold at once can
  // never both match — the promotion event fires exactly once, never
  // repeated on re-crossing. Wrapped in a transaction with the event_log
  // insert so a failure between the two can never leave promoted_at set
  // with no corresponding event (a silently dropped promotion) — both
  // commit together or neither does, matching #26's merge.ts transaction
  // precedent.
  const { concernThresholdT2 } = loadConfig(env as unknown as Record<string, string | undefined>);
  await db.transaction(async (tx) => {
    const [promoted] = await tx
      .update(schema.issues)
      .set({ promotedAt: sql`now()` })
      .where(
        and(
          eq(schema.issues.issueId, issueId),
          isNull(schema.issues.promotedAt),
          gte(schema.issues.supportT2Count, concernThresholdT2),
        ),
      )
      .returning({ supportT2Count: schema.issues.supportT2Count });

    if (promoted) {
      await tx.insert(schema.eventLog).values({
        kind: "issue_promoted_to_concern",
        subjectType: "issue",
        subjectId: issueId,
        payload: { supportT2Count: promoted.supportT2Count },
      });
    }
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
  return handleSupport(request, env, issueId);
};
