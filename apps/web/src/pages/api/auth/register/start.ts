import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  checkPseudonym,
  hashRateLimitKeyComponent,
  loadMagicLinkConfig,
  loadRateLimitConfig,
  registrationRequestSchema,
  verifyTurnstile,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";
import { sendDuplicateEmailNotice, sendMagicLinkEmail } from "../../../../lib/resend";

/**
 * A1 — T0 registration (issue #20), the "send" half of the email
 * magic-link flow. Pure function taking `env` explicitly so it's directly
 * unit-testable under plain Vitest — `POST` below is the only thing that
 * touches the real Cloudflare bindings, via a lazy `cloudflare:workers`
 * import (a virtual module only resolvable inside a real Workers/Miniflare
 * runtime, never at module load time — see env.d.ts).
 */
export async function handleStart(
  request: Request,
  clientAddress: string,
  env: Cloudflare.Env,
): Promise<Response> {
  const rawBody: unknown = await request.json().catch(() => undefined);
  const parsed = registrationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const { email, pseudonym, locale, turnstileToken } = parsed.data;

  const rateLimitConfig = loadRateLimitConfig(env as unknown as Record<string, string | undefined>);

  const ipLimit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:register:ip:${clientAddress}:${hourBucket()}`,
    rateLimitConfig.registerRateLimitPerIpPerHour,
    3600,
  );
  if (!ipLimit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const turnstileOk = await verifyTurnstile(
    turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    clientAddress,
  );
  if (!turnstileOk) {
    return Response.json({ error: "turnstile_failed" }, { status: 403 });
  }

  // Hashed, not the raw address — a KV rate-limit key is not the vault,
  // and plaintext email has no business sitting in a cache entry even
  // with a short TTL (CLAUDE.md invariant 1's spirit: identity data lives
  // in packages/vault-db only, not scattered into every store an endpoint
  // happens to touch).
  const emailKeyComponent = await hashRateLimitKeyComponent(email.toLowerCase());
  const emailLimit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:register:email:${emailKeyComponent}:${hourBucket()}`,
    rateLimitConfig.registerRateLimitPerEmailPerHour,
    3600,
  );
  if (!emailLimit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const pseudonymCheck = checkPseudonym(pseudonym);
  if (!pseudonymCheck.allowed) {
    const error =
      pseudonymCheck.reason === "party-name" ? "pseudonym_party_name" : "pseudonym_profanity";
    return Response.json({ error }, { status: 400 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [existingMember] = await db
    .select({ memberId: schema.members.memberId })
    .from(schema.members)
    .where(eq(schema.members.pseudonym, pseudonym))
    .limit(1);
  if (existingMember) {
    return Response.json({ error: "pseudonym_taken" }, { status: 409 });
  }

  const vaultRes = await env.VAULT_SVC.fetch(
    "https://vault-svc.internal/internal/registrations/start",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VAULT_SVC_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, pseudonym, locale }),
    },
  );

  // Anti-enumeration: a caller must never be able to tell from this
  // response whether an email is already registered — that's an identity
  // ↔ participation correlation leaked over HTTP instead of a DB join,
  // exactly what the vault split exists to prevent. Both branches below
  // return the identical 202 {sent: true}; only the email content differs
  // (server-side, never visible to the caller).
  if (vaultRes.status === 409) {
    const sent = await sendDuplicateEmailNotice({ to: email, locale }, env.RESEND_API_KEY);
    if (!sent) {
      return Response.json({ error: "email_send_failed" }, { status: 500 });
    }
    return Response.json({ sent: true }, { status: 202 });
  }
  if (!vaultRes.ok) {
    return Response.json({ error: "registration_start_failed" }, { status: 502 });
  }

  const { rawToken } = (await vaultRes.json()) as { registrationId: string; rawToken: string };
  const verifyLink = new URL(`/api/auth/register/verify?token=${rawToken}`, request.url).toString();
  const { magicLinkTtlMinutes } = loadMagicLinkConfig(
    env as unknown as Record<string, string | undefined>,
  );

  const sent = await sendMagicLinkEmail(
    { to: email, link: verifyLink, locale, ttlMinutes: magicLinkTtlMinutes },
    env.RESEND_API_KEY,
  );
  if (!sent) {
    return Response.json({ error: "email_send_failed" }, { status: 500 });
  }

  return Response.json({ sent: true }, { status: 202 });
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const { env } = await import("cloudflare:workers");
  return handleStart(request, clientAddress, env);
};
