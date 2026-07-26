import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { loadStatementModerationAdminConfig, statementModerationActionSchema } from "shared";
import { requireAdminAccess } from "../../../../../lib/admin-auth";
import { getServiceRoleDb } from "../../../../../lib/db";

// C1 — minimal admin-gated statement moderation (issue #33). Module H's
// real moderation queue/console (issue #29) doesn't exist yet, so this
// mirrors #26's merge.ts pattern exactly: internal-ops-only, two
// independent factors (bearer token + IP allowlist via
// loadStatementModerationAdminConfig/requireAdminAccess), no session/
// cookie auth. Explicitly NOT a substitute for #29's full console — this
// just unblocks "approved statements are servable" without waiting on it,
// and writes to the *existing* moderationActions table (a natural on-ramp
// into #29's later public moderation log) rather than inventing new
// columns/tables.
export async function handleStatementModerate(
  request: Request,
  env: Cloudflare.Env,
  statementId: string,
  clientAddress: string,
): Promise<Response> {
  const { adminToken, ipAllowlist } = loadStatementModerationAdminConfig(
    env as unknown as Record<string, string | undefined>,
  );
  if (!requireAdminAccess(request, clientAddress, adminToken, ipAllowlist)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = statementModerationActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [statement] = await db
    .select({ status: schema.statements.status })
    .from(schema.statements)
    .where(eq(schema.statements.statementId, statementId))
    .limit(1);

  if (!statement) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (statement.status !== "pending") {
    return Response.json({ error: "already_moderated" }, { status: 409 });
  }

  const newStatus = parsed.data.action === "approve" ? "approved" : "rejected";

  await db.transaction(async (tx) => {
    await tx
      .update(schema.statements)
      .set({ status: newStatus })
      .where(eq(schema.statements.statementId, statementId));

    await tx.insert(schema.moderationActions).values({
      subject: `statement:${statementId}`,
      ruleCited: parsed.data.ruleCited,
      action: parsed.data.action,
      publicNote: parsed.data.publicNote ?? null,
    });
  });

  return Response.json({ ok: true }, { status: 200 });
}

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  const statementId = params.statementId;
  if (!statementId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handleStatementModerate(request, env, statementId, clientAddress);
};
