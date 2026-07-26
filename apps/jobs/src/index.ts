// Cron Worker per HLD §3: consensus clustering, response-clock flags, RTI
// deadline watcher, ledger stat refresh, cache-tag purge queue.
//
// Issue #35 (C3) is the first real job: the deliberation lifecycle sweep
// (Open/Extended->Closed->Summarized). scheduled() stays a thin wrapper —
// all real logic lives in runDeliberationLifecycleSweep (lifecycle-sweep.ts),
// which is what's actually unit-tested (against a real Postgres), same
// split as apps/web/src/pages/api/issues/[issueId]/support.ts's
// handleSupport/POST.
//
// fetch()'s POST /internal/sweep is the demo-only manual trigger (not part
// of any issue's literal AC — see the approved plan) so a stakeholder demo
// isn't blocked on the real 14-day window: apps/web's
// POST /api/admin/deliberations/sweep (human-facing, bearer+IP gated) calls
// this over a Cloudflare service binding (env.JOBS_SVC), exactly the same
// cross-Worker pattern apps/web already uses for VAULT_SVC. This route is
// itself gated by a shared bearer token (JOBS_INTERNAL_TOKEN) — mirrors
// apps/vault-svc/src/auth.ts's requireInternalToken (manual, no Hono
// dependency here since this Worker has no router otherwise).
//
// Security review note: this is deliberately single-factor (token only, no
// IP allowlist) — safe ONLY because wrangler.jsonc sets `workers_dev:
// false`, so the only path a request can reach fetch() at all is the
// JOBS_SVC service binding, never a public URL. If that ever changes, this
// route needs a second factor added (an IP allowlist, same shape as
// apps/web/src/lib/admin-auth.ts's requireAdminAccess) before it's safe.
import { createDbClient } from "db";
import { loadConsensusConfig } from "shared";
import { runDeliberationLifecycleSweep } from "./lifecycle-sweep";

export interface JobsEnv {
  APP_DATABASE_URL: string;
  DELIBERATION_ARTIFACTS: R2Bucket;
  CONSENSUS_AGREEMENT_THRESHOLD_PERCENT: string;
  CONSENSUS_MIN_VOTERS: string;
  JOBS_INTERNAL_TOKEN: string;
}

// Manual constant-time compare — same implementation as
// apps/vault-svc/src/auth.ts's timingSafeEqual and
// apps/web/src/lib/admin-auth.ts's requireAdminAccess (no Node
// crypto.timingSafeEqual dependency, so it works without nodejs_compat).
function timingSafeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function runSweep(env: JobsEnv): Promise<Response> {
  const db = createDbClient(env.APP_DATABASE_URL);
  const config = loadConsensusConfig(env as unknown as Record<string, string | undefined>);
  const result = await runDeliberationLifecycleSweep(db, env.DELIBERATION_ARTIFACTS, config);
  return Response.json(result, { status: 200 });
}

export default {
  async scheduled(_controller: ScheduledController, env: JobsEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runSweep(env).catch(() => undefined));
  },

  async fetch(request: Request, env?: JobsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/sweep" && env) {
      const header = request.headers.get("Authorization");
      const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      if (!token || !env.JOBS_INTERNAL_TOKEN || !timingSafeEqual(token, env.JOBS_INTERNAL_TOKEN)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return runSweep(env);
    }

    return new Response("ok", { status: 200 });
  },
};
