import type { APIRoute } from "astro";
import { schema } from "db";
import { and, eq, ilike } from "drizzle-orm";
import { getServiceRoleDb } from "../../../lib/db";

// B3 — Support & Dedup (issue #26). GET /api/issues/similar?titleEn=&category=
// is a deliberately unranked, unauthed "ship a reasonable first pass" nudge
// (approved plan) — an ILIKE substring match against PUBLISHED issues'
// titleEn within the same category, capped to 3 results, no pg_trgm/ranking
// model. No session required: it only reads data that's already public
// (published issues). Used by the raise-issue form to suggest "similar issue
// exists, support it instead" as the user types a title.

export async function handleSimilar(request: Request, env: Cloudflare.Env): Promise<Response> {
  const url = new URL(request.url);
  const titleEn = url.searchParams.get("titleEn") ?? "";
  const category = url.searchParams.get("category") ?? "";

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const results = await db
    .select({
      issueId: schema.issues.issueId,
      slug: schema.issues.slug,
      titleEn: schema.issues.titleEn,
    })
    .from(schema.issues)
    .where(
      and(
        eq(schema.issues.status, "published"),
        eq(schema.issues.category, category),
        ilike(schema.issues.titleEn, `%${titleEn}%`),
      ),
    )
    .limit(3);

  return Response.json(results);
}

export const GET: APIRoute = async ({ request }) => {
  const { env } = await import("cloudflare:workers");
  return handleSimilar(request, env);
};
