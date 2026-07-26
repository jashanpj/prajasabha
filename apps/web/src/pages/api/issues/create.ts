import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  issueCreateSchema,
  loadIssueCreateRateLimitConfig,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../lib/db";

// B1 — create a draft issue (issue #24). Session-authed; the ONE tier gate
// in the B1 flow: members.tier must be t1+ ("only T1+ can raise", #24's
// authz AC). Tiers are monotonic (t0→t1→t2), so t2 implies raise access
// and draft.ts/photos.ts/publish.ts re-check only ownership, not tier.
//
// Creation requires only wardId — the single NOT-NULL issues column that
// can't be safely defaulted (it drives routing, B2). titleMl/titleEn/body/
// category start as '' and are filled in by the debounced autosave PATCH
// (draft.ts); publish.ts is the gate that refuses to make an incomplete
// draft public. The slug gets a throwaway unique placeholder here — the
// real, title-derived slug is minted at publish time.

// zod isn't a direct dependency of apps/web (strict pnpm node_modules) —
// the create body is just issueCreateSchema's wardId field, picked.
const createBodySchema = issueCreateSchema.pick({ wardId: true });

export async function handleCreate(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { issueCreateRateLimitPerMemberPerHour } = loadIssueCreateRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:issue-create:member:${session.memberId}:${hourBucket()}`,
    issueCreateRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = createBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [member] = await db
    .select({ tier: schema.members.tier })
    .from(schema.members)
    .where(eq(schema.members.memberId, session.memberId))
    .limit(1);

  if (!member) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (member.tier === "t0") {
    return Response.json({ error: "tier_too_low" }, { status: 403 });
  }

  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: `draft-${crypto.randomUUID()}`,
      titleMl: "",
      titleEn: "",
      body: "",
      category: "",
      wardId: parsed.data.wardId,
      status: "draft",
      createdBy: session.memberId,
    })
    .returning({ issueId: schema.issues.issueId });

  if (!inserted) {
    return Response.json({ error: "create_failed" }, { status: 500 });
  }

  // B5 — Issue Timeline (issue #28). The first entry a timeline can ever
  // show — fired at draft creation, not publish, so "created" is the true
  // start of the record even though the issue isn't publicly visible yet.
  await db.insert(schema.eventLog).values({
    actorMemberId: session.memberId,
    kind: "issue_created",
    subjectType: "issue",
    subjectId: inserted.issueId,
  });

  return Response.json({ issueId: inserted.issueId }, { status: 201 });
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

export const POST: APIRoute = async ({ request }) => {
  const { env } = await import("cloudflare:workers");
  return handleCreate(request, env);
};
