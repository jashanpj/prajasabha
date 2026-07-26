import type { APIRoute } from "astro";
import {
  checkAndIncrement,
  epicVerificationSubmissionSchema,
  loadEpicLinkRateLimitConfig,
  verifySession,
} from "shared";

/**
 * A3 — EPIC verification submission (issue #22), the "link" half of the
 * browser->vault-svc->apps/web flow (see verify/epic.astro): the browser
 * has already posted the raw EPIC number + doc straight to vault-svc's
 * public /public/epic/submit endpoint and gotten back an opaque docRef —
 * this endpoint only ever sees {memberId, docRef}, never the EPIC number
 * itself. Session-authed so vault-svc's /internal/epic/link call is always
 * made with the memberId this browser is actually logged in as.
 */
export async function handleSubmit(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => undefined);
  const parsed = epicVerificationSubmissionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const { memberId, docRef } = parsed.data;

  if (memberId !== session.memberId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Rate-limited per-member — this is the one call in the flow that can
  // reveal "an EPIC number is already verified by someone else" (409
  // duplicate_epic), so it gets the same volumetric protection as any
  // other enumeration-shaped endpoint, not just Turnstile on the upstream
  // vault-svc submit call.
  const { epicLinkRateLimitPerMemberPerHour } = loadEpicLinkRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const memberLimit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:epic-link:member:${memberId}:${hourBucket()}`,
    epicLinkRateLimitPerMemberPerHour,
    3600,
  );
  if (!memberLimit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const linkRes = await env.VAULT_SVC.fetch("https://vault-svc.internal/internal/epic/link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VAULT_SVC_INTERNAL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ memberId, docRef }),
  });

  const body = await linkRes.json().catch(() => ({}));
  if (linkRes.status === 200) {
    return Response.json(body, { status: 202 });
  }
  return Response.json(body, { status: linkRes.status });
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export const POST: APIRoute = async ({ request }) => {
  const { env } = await import("cloudflare:workers");
  return handleSubmit(request, env);
};
