import type { APIRoute } from "astro";
import { schema } from "db";
import { checkAndIncrement, loadRateLimitConfig, signSession } from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A1 — T0 registration (issue #20), the "verify" half. Consumes the
 * magic-link token (atomically, via apps/vault-svc), creates the member
 * row, and issues a minimal signed session cookie. Pure function taking
 * `env` explicitly — see start.ts's docstring for why (Astro v6 removed
 * `locals.runtime.env`; `GET` below does the lazy `cloudflare:workers`
 * import instead).
 */
export async function handleVerify(
  request: Request,
  clientAddress: string,
  env: Cloudflare.Env,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return Response.json({ error: "missing_token" }, { status: 400 });
  }

  const rateLimitConfig = loadRateLimitConfig(env as unknown as Record<string, string | undefined>);
  const ipLimit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:verify:ip:${clientAddress}:${hourBucket()}`,
    rateLimitConfig.verifyRateLimitPerIpPerHour,
    3600,
  );
  if (!ipLimit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const consumeRes = await env.VAULT_SVC.fetch(
    "https://vault-svc.internal/internal/registrations/consume",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VAULT_SVC_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rawToken: token }),
    },
  );

  if (consumeRes.status === 404) {
    return Response.json({ error: "invalid_token" }, { status: 404 });
  }
  if (consumeRes.status === 410) {
    return Response.json({ error: "expired_or_consumed_token" }, { status: 410 });
  }
  if (!consumeRes.ok) {
    return Response.json({ error: "verify_failed" }, { status: 502 });
  }

  const { registrationId, pseudonym, locale } = (await consumeRes.json()) as {
    registrationId: string;
    pseudonym: string;
    locale: "ml" | "en";
  };

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  let memberId: string;
  try {
    const [inserted] = await db
      .insert(schema.members)
      .values({ pseudonym, tier: "t0", locale })
      .returning({ memberId: schema.members.memberId });
    if (!inserted) throw new Error("member insert returned no row");
    memberId = inserted.memberId;
  } catch {
    // The token is already consumed and can't be replayed by design — the
    // user must restart registration with a different pseudonym. Logged
    // (not silently swallowed) via event_log; no identity data in the
    // payload (vault join rule).
    await db.insert(schema.eventLog).values({
      kind: "registration_failed_after_token_consumed",
      subjectType: "registration",
      subjectId: registrationId,
    });
    return Response.json({ error: "registration_conflict" }, { status: 409 });
  }

  // Best-effort: mark the vault-side row complete (a bare boolean flip —
  // never sends memberId; vault-db must never learn which member an email
  // belongs to, see packages/vault-db/src/schema.ts's `linked` column
  // comment). This is what makes "duplicate email blocked" durable after a
  // successful registration; a failure here just means that email could
  // theoretically register again later, which is the safer failure mode.
  await env.VAULT_SVC.fetch(
    `https://vault-svc.internal/internal/registrations/${registrationId}/complete`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.VAULT_SVC_INTERNAL_TOKEN}` },
    },
  ).catch(() => undefined);

  const sessionCookie = await signSession(
    memberId,
    env.SESSION_SECRET,
    Date.now() + THIRTY_DAYS_MS,
  );

  return new Response(null, {
    status: 303,
    headers: {
      // Issue #86 — the next actionable step for a freshly-verified T0
      // member: T1/Aadhaar is postponed, so EPIC verification is the only
      // path to full participation (flips tier straight to 't2').
      Location: "/verify/epic",
      "Set-Cookie": `ps_session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${THIRTY_DAYS_MS / 1000}`,
    },
  });
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const { env } = await import("cloudflare:workers");
  return handleVerify(request, clientAddress, env);
};
