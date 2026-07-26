import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { loadEpicVerificationConfig, verifySession } from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

interface VaultStatusBody {
  status: "pending" | "approved" | "rejected";
  assemblySegmentClaimed: string;
  reviewedAt: string | null;
}

/**
 * A3 — EPIC verification status (issue #22). Session-authed; calls
 * vault-svc's /internal/epic/status and, on `approved`, is the ONE place
 * that flips packages/db's members.tier to 't2' — never vault-svc itself,
 * which must never write to packages/db (CLAUDE.md invariant 1/2). This is
 * the pull-based equivalent of HLD §4.3's confirmTier(): called whenever
 * the member visits their verification-status page, no cron job needed.
 */
export async function handleStatus(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const statusRes = await env.VAULT_SVC.fetch(
    `https://vault-svc.internal/internal/epic/status?memberId=${session.memberId}`,
    { headers: { Authorization: `Bearer ${env.VAULT_SVC_INTERNAL_TOKEN}` } },
  );

  if (statusRes.status === 404) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!statusRes.ok) {
    return Response.json({ error: "status_failed" }, { status: 502 });
  }

  const vaultStatus = (await statusRes.json()) as VaultStatusBody;
  if (vaultStatus.status !== "approved") {
    return Response.json(vaultStatus);
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [member] = await db
    .select({ tier: schema.members.tier })
    .from(schema.members)
    .where(eq(schema.members.memberId, session.memberId))
    .limit(1);

  if (member && member.tier !== "t2") {
    const { coveredAssemblySegments } = loadEpicVerificationConfig(
      env as unknown as Record<string, string | undefined>,
    );
    const assemblySegmentCovered = coveredAssemblySegments.some(
      (segment) => segment.toLowerCase() === vaultStatus.assemblySegmentClaimed.toLowerCase(),
    );

    await db
      .update(schema.members)
      .set({
        tier: "t2",
        assemblySegment: vaultStatus.assemblySegmentClaimed,
        assemblySegmentCovered,
      })
      .where(eq(schema.members.memberId, session.memberId));

    return Response.json({
      tier: "t2",
      assemblySegment: vaultStatus.assemblySegmentClaimed,
      assemblySegmentCovered,
      status: "approved",
    });
  }

  const [current] = await db
    .select({
      tier: schema.members.tier,
      assemblySegment: schema.members.assemblySegment,
      assemblySegmentCovered: schema.members.assemblySegmentCovered,
    })
    .from(schema.members)
    .where(eq(schema.members.memberId, session.memberId))
    .limit(1);

  return Response.json({
    tier: current?.tier ?? "t2",
    assemblySegment: current?.assemblySegment ?? null,
    assemblySegmentCovered: current?.assemblySegmentCovered ?? null,
    status: "approved",
  });
}

function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export const GET: APIRoute = async ({ request }) => {
  const { env } = await import("cloudflare:workers");
  return handleStatus(request, env);
};
