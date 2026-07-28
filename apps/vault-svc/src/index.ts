import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { loadMagicLinkConfig } from "shared";
import { createVaultDbClient, encryptEmail, hashEmail, schema } from "vault-db";
import { logVaultAccess } from "./access-log";
import { requireInternalToken } from "./auth";
import type { Bindings } from "./env";
import { registerEpicRoutes } from "./epic";

// Internal-only routes (issue #20): called exclusively by apps/web via a
// Cloudflare service binding (env.VAULT_SVC), never a public URL. This is
// the ONE app allowed to import packages/vault-db — see
// packages/shared/src/lint/vault-isolation.ts's ALLOWED_VAULT_DB_IMPORTERS.
const app = new Hono<{ Bindings: Bindings }>();

app.use("/internal/*", async (c, next) =>
  requireInternalToken(c.env.VAULT_SVC_INTERNAL_TOKEN)(c, next),
);

// Issue #16/#22 — A3 EPIC verification (/public/epic/*, /internal/epic/*,
// /review/epic/*). Registered onto this same app instance so the
// "/internal/*" middleware above already covers /internal/epic/* — see
// epic.ts for /review/epic/*'s own, separate requireReviewAccess gate.
registerEpicRoutes(app);

async function hashToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // base64url, no padding — safe as a URL query param.
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

interface StartBody {
  email: string;
  pseudonym: string;
  locale: string;
}

app.post("/internal/registrations/start", async (c) => {
  const { email, pseudonym, locale } = await c.req.json<StartBody>();
  const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);
  const { magicLinkTtlMinutes } = loadMagicLinkConfig(
    c.env as unknown as Record<string, string | undefined>,
  );

  const emailHash = await hashEmail(email, c.env.EMAIL_HASH_PEPPER);

  const existingLinked = await db
    .select({ id: schema.authCredentials.id })
    .from(schema.authCredentials)
    .where(
      and(eq(schema.authCredentials.emailHash, emailHash), eq(schema.authCredentials.linked, true)),
    )
    .limit(1);

  // Issue #23 — this SELECT probes for an existing account by email hash, so
  // even a zero-row answer is a fact about a real person's email. Logged
  // either way; `outcome` records which answer the caller got.
  await logVaultAccess(db, c.env as unknown as Record<string, string | undefined>, {
    operation: "registration.start.duplicate_check",
    caller: "internal",
    outcome: existingLinked.length > 0 ? "ok" : "not_found",
    rowCount: existingLinked.length,
    subjectRef: existingLinked[0]?.id ?? null,
  });

  if (existingLinked.length > 0) {
    return c.json({ reason: "duplicate_email" }, 409);
  }

  const rawToken = generateRawToken();
  const tokenHash = await hashToken(rawToken);
  const { ciphertext, iv } = await encryptEmail(email, c.env.EMAIL_ENCRYPTION_KEY);

  const [inserted] = await db
    .insert(schema.authCredentials)
    .values({
      emailHash,
      emailCiphertext: ciphertext,
      emailIv: iv,
      pseudonym,
      locale,
      tokenHash,
      expiresAt: new Date(Date.now() + magicLinkTtlMinutes * 60_000),
    })
    .returning({ id: schema.authCredentials.id });

  if (!inserted) {
    return c.json({ error: "insert_failed" }, 500);
  }

  return c.json({ registrationId: inserted.id, rawToken });
});

interface ConsumeBody {
  rawToken: string;
}

app.post("/internal/registrations/consume", async (c) => {
  const { rawToken } = await c.req.json<ConsumeBody>();
  const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);
  const tokenHash = await hashToken(rawToken);

  // Atomic single-use consume: the WHERE clause only matches an
  // unconsumed, unexpired row, so Postgres's row lock makes concurrent
  // double-consume race-safe — exactly one caller ever gets a row back.
  const [consumed] = await db
    .update(schema.authCredentials)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(schema.authCredentials.tokenHash, tokenHash),
        isNull(schema.authCredentials.consumedAt),
        sql`${schema.authCredentials.expiresAt} > now()`,
      ),
    )
    .returning({
      id: schema.authCredentials.id,
      pseudonym: schema.authCredentials.pseudonym,
      locale: schema.authCredentials.locale,
    });

  if (consumed) {
    // Issue #23 — identity data (pseudonym, locale) leaves the vault here.
    // That makes this a read for audit purposes even though the statement is
    // an UPDATE ... RETURNING.
    await logVaultAccess(db, c.env as unknown as Record<string, string | undefined>, {
      operation: "registration.consume",
      caller: "internal",
      outcome: "ok",
      rowCount: 1,
      subjectRef: consumed.id,
    });
    return c.json({
      registrationId: consumed.id,
      pseudonym: consumed.pseudonym,
      locale: consumed.locale,
    });
  }

  // Distinguish "never existed" from "expired or already consumed" for a
  // clearer client-side error message — a second, read-only lookup, safe
  // to run after the atomic UPDATE already resolved the race.
  const [existing] = await db
    .select({ id: schema.authCredentials.id })
    .from(schema.authCredentials)
    .where(eq(schema.authCredentials.tokenHash, tokenHash))
    .limit(1);

  await logVaultAccess(db, c.env as unknown as Record<string, string | undefined>, {
    operation: "registration.consume",
    caller: "internal",
    outcome: existing ? "ok" : "not_found",
    rowCount: existing ? 1 : 0,
    subjectRef: existing?.id ?? null,
  });

  return c.json(
    { error: existing ? "expired_or_consumed_token" : "invalid_token" },
    existing ? 410 : 404,
  );
});

// Marks a registration "complete" once packages/db's member insert
// succeeds — a bare boolean flip, never the resulting member_id. vault-db
// must never be able to answer "which member does this email belong to"
// (see schema.ts's comment on the `linked` column) — this endpoint takes
// no body at all, deliberately, so there is no code path that could ever
// persist a member_id here.
app.post("/internal/registrations/:id/complete", async (c) => {
  const registrationId = c.req.param("id");
  const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

  // Defense-in-depth: only a consumed (verified) registration may be
  // marked complete, even though the normal call sequence from apps/web
  // always consumes before completing.
  const [completed] = await db
    .update(schema.authCredentials)
    .set({ linked: true })
    .where(
      and(
        eq(schema.authCredentials.id, registrationId),
        eq(schema.authCredentials.linked, false),
        isNotNull(schema.authCredentials.consumedAt),
      ),
    )
    .returning({ id: schema.authCredentials.id });

  if (completed) {
    return c.json({});
  }

  const [existing] = await db
    .select({
      linked: schema.authCredentials.linked,
      consumedAt: schema.authCredentials.consumedAt,
    })
    .from(schema.authCredentials)
    .where(eq(schema.authCredentials.id, registrationId))
    .limit(1);

  await logVaultAccess(db, c.env as unknown as Record<string, string | undefined>, {
    operation: "registration.complete.lookup",
    caller: "internal",
    outcome: existing ? "ok" : "not_found",
    rowCount: existing ? 1 : 0,
    subjectRef: registrationId,
  });

  if (!existing) {
    return c.json({ error: "unknown_registration" }, 404);
  }
  if (existing.linked) {
    return c.json({ error: "already_linked" }, 409);
  }
  return c.json({ error: "not_yet_consumed" }, 409);
});

export default app;
