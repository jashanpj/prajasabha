import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { getServiceRoleDb } from "../../../../lib/db";

// C2 — Consensus summary export (issue #34). Public, no session: this is
// a public artifact, matching the mockup's public Timeline entry ("6 Jul
// — Consensus report published", issue #35's deliberation_summarized
// event). Thin passthrough only — the PDF is generated exactly once by
// the cron/demo sweep's closed->summarized transition (apps/jobs'
// lifecycle-sweep.ts), never regenerated on demand here. The live,
// still-moving numbers belong on the issue detail page instead (computed
// fresh on every load — see issues/[slug].astro).
export async function handleConsensusExport(
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [issue] = await db
    .select({ status: schema.issues.status })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, issueId))
    .limit(1);

  // Security-review fix: same authz-parity gate as statements.ts/next.ts/
  // vote.ts — a draft was never public, and a *closed* issue's history
  // should stop serving new artifact requests too. `merged` is allowed,
  // matching issues/[slug].astro's own visibility gate ("merge preserves
  // both threads' history" — a merged issue's consensus report stays
  // reachable, same as its page).
  if (!issue || (issue.status !== "published" && issue.status !== "merged")) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const [deliberation] = await db
    .select({
      state: schema.deliberations.state,
      summaryArtifactKey: schema.deliberations.summaryArtifactKey,
    })
    .from(schema.deliberations)
    .where(eq(schema.deliberations.issueId, issueId))
    .limit(1);

  if (!deliberation) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (deliberation.state !== "summarized" || !deliberation.summaryArtifactKey) {
    return Response.json({ error: "not_yet_summarized" }, { status: 409 });
  }

  const object = await env.DELIBERATION_ARTIFACTS.get(deliberation.summaryArtifactKey);
  if (!object) {
    return Response.json({ error: "artifact_missing" }, { status: 404 });
  }

  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

export const GET: APIRoute = async ({ params }) => {
  const issueId = params.issueId;
  if (!issueId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleConsensusExport(env, issueId);
};
