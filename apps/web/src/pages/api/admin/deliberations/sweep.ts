import type { APIRoute } from "astro";
import { loadDeliberationSweepAdminConfig } from "shared";
import { requireAdminAccess } from "../../../../lib/admin-auth";

// Issue #35 — C3's demo-only manual sweep trigger. NOT part of any issue's
// literal AC — added per the approved plan so a stakeholder demo isn't
// blocked on the real 14-day deliberation window. Internal-ops-only, same
// bearer-token + IP-allowlist gate as #26's merge endpoint
// (loadDeliberationSweepAdminConfig/requireAdminAccess), deliberately
// separate token/allowlist vars from ISSUE_MERGE_ADMIN_* since this gates a
// different endpoint with a different blast radius (force-closing/
// summarizing deliberations, not merging issues).
//
// This endpoint does no DB work itself — it forwards the call to apps/jobs
// (the actual owner of deliberation-lifecycle mutations) over a Cloudflare
// service binding, the same cross-Worker pattern already used for
// VAULT_SVC. apps/jobs' own /internal/sweep route re-authenticates with its
// own shared bearer token (JOBS_INTERNAL_TOKEN) — this call is never
// trusted merely because it arrived over the binding.
export async function handleSweep(
  request: Request,
  env: Cloudflare.Env,
  clientAddress: string,
): Promise<Response> {
  const { adminToken, ipAllowlist } = loadDeliberationSweepAdminConfig(
    env as unknown as Record<string, string | undefined>,
  );
  if (!requireAdminAccess(request, clientAddress, adminToken, ipAllowlist)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const jobsRes = await env.JOBS_SVC.fetch("https://jobs.internal/internal/sweep", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.JOBS_INTERNAL_TOKEN}` },
  });

  const body = await jobsRes.text();
  return new Response(body, {
    status: jobsRes.status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const { env } = await import("cloudflare:workers");
  return handleSweep(request, env, clientAddress);
};
