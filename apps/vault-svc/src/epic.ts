import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  checkAndIncrement,
  loadEpicSubmitRateLimitConfig,
  loadReviewQueueConfig,
  verifyTurnstile,
} from "shared";
import {
  createVaultDbClient,
  decryptDoc,
  decryptEpicNumber,
  encryptDoc,
  encryptEpicNumber,
  hashEpicNumber,
  schema,
} from "vault-db";
import { z } from "zod";
import type { Bindings } from "./env";
import { requireReviewAccess } from "./review-auth";

// Issue #16/#22 — A3 EPIC (voter ID) verification, T2 tier. Three route
// groups, three different auth postures:
//   - /public/epic/submit: no service-to-service auth at all — the
//     browser calls this directly (HLD §4.3's "separate origin"), gated
//     only by Turnstile. Deliberately NOT in packages/shared (see
//     packages/shared/src/schemas.ts's epicVerificationSubmissionSchema
//     comment) — the raw EPIC number/doc never need a shape apps/web,
//     apps/api, or apps/jobs could import and reuse as a log payload.
//   - /internal/epic/*: requireInternalToken, same posture as
//     /internal/registrations/* in index.ts — apps/web only, via the
//     VAULT_SVC service binding.
//   - /review/epic/*: requireReviewAccess — a human reviewer's browser,
//     completely separate token + IP allowlist from requireInternalToken.

const SLA_HOURS = 72;
// Base64 ceiling for the uploaded doc/photo — bounds the AES-GCM encrypt
// and DB insert work a single unauthenticated request can trigger. ~8MB of
// base64 is comfortably more than a phone-camera photo of a voter ID card
// needs; real document-size limits are a follow-up alongside real R2/
// DigiLocker storage (see the plan's doc-storage scope note).
const MAX_DOC_BASE64_LENGTH = 8_000_000;

const submitSchema = z.object({
  epicNumber: z.string().min(1),
  docBase64: z.string().min(1).max(MAX_DOC_BASE64_LENGTH),
  assemblySegmentClaimed: z.string().min(1),
  turnstileToken: z.string().min(1),
});

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

const linkSchema = z.object({
  memberId: z.string().uuid(),
  docRef: z.string().uuid(),
});

const approveSchema = z.object({
  assemblySegmentConfirmed: z.string().min(1),
});

const rejectSchema = z.object({
  reviewerNote: z.string().min(1),
});

export function registerEpicRoutes(app: Hono<{ Bindings: Bindings }>): void {
  app.post("/public/epic/submit", async (c) => {
    const parsed = submitSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const { epicNumber, docBase64, assemblySegmentClaimed, turnstileToken } = parsed.data;

    // Rate-limited per-IP (no member session exists yet at this point in
    // the flow) — Turnstile alone is not treated as sufficient volumetric
    // protection anywhere else in this codebase either (see register/
    // start.ts's IP + email limits on the same threat model).
    const clientIp = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { epicSubmitRateLimitPerIpPerHour } = loadEpicSubmitRateLimitConfig(
      c.env as unknown as Record<string, string | undefined>,
    );
    const ipLimit = await checkAndIncrement(
      c.env.RATE_LIMIT_KV,
      `ratelimit:epic-submit:ip:${clientIp}:${hourBucket()}`,
      epicSubmitRateLimitPerIpPerHour,
      3600,
    );
    if (!ipLimit.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const turnstileOk = await verifyTurnstile(
      turnstileToken,
      c.env.TURNSTILE_SECRET_KEY,
      c.req.header("CF-Connecting-IP"),
    );
    if (!turnstileOk) {
      return c.json({ error: "turnstile_failed" }, 403);
    }

    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);
    const epicNumberHash = await hashEpicNumber(epicNumber, c.env.EPIC_HASH_PEPPER);
    const epicNumberEncrypted = await encryptEpicNumber(epicNumber, c.env.EPIC_ENCRYPTION_KEY);
    const docEncrypted = await encryptDoc(docBase64, c.env.EPIC_DOC_ENCRYPTION_KEY);

    const [inserted] = await db
      .insert(schema.epicVerifications)
      .values({
        epicNumberHash,
        epicNumberCiphertext: epicNumberEncrypted.ciphertext,
        epicNumberIv: epicNumberEncrypted.iv,
        docCiphertext: docEncrypted.ciphertext,
        docIv: docEncrypted.iv,
        assemblySegmentClaimed,
      })
      .returning({ verificationId: schema.epicVerifications.verificationId });

    if (!inserted) {
      return c.json({ error: "insert_failed" }, 500);
    }

    return c.json({ docRef: inserted.verificationId }, 202);
  });

  app.post("/internal/epic/link", async (c) => {
    const parsed = linkSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const { memberId, docRef } = parsed.data;
    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

    const [orphaned] = await db
      .select({
        verificationId: schema.epicVerifications.verificationId,
        epicNumberHash: schema.epicVerifications.epicNumberHash,
      })
      .from(schema.epicVerifications)
      .where(
        and(
          eq(schema.epicVerifications.verificationId, docRef),
          isNull(schema.epicVerifications.memberId),
        ),
      )
      .limit(1);

    if (!orphaned) {
      return c.json({ error: "unknown_doc_ref" }, 404);
    }

    // Proactive "one EPIC number = one account" check (issue #22 AC4) — the
    // partial unique index on epic_number_hash WHERE status='approved' is
    // the real DB-level guarantee; this check just gives the caller a
    // friendly, distinguishable "collision -> support flow" signal instead
    // of a raw constraint-violation error, and deliberately leaves the row
    // orphaned (memberId still null) rather than linking it.
    const [existingApproved] = await db
      .select({ verificationId: schema.epicVerifications.verificationId })
      .from(schema.epicVerifications)
      .where(
        and(
          eq(schema.epicVerifications.epicNumberHash, orphaned.epicNumberHash),
          eq(schema.epicVerifications.status, "approved"),
          ne(schema.epicVerifications.verificationId, orphaned.verificationId),
        ),
      )
      .limit(1);

    if (existingApproved) {
      return c.json({ error: "duplicate_epic" }, 409);
    }

    await db
      .update(schema.epicVerifications)
      .set({ memberId })
      .where(eq(schema.epicVerifications.verificationId, docRef));

    return c.json({ verificationId: docRef, status: "pending" });
  });

  app.get("/internal/epic/status", async (c) => {
    const memberId = c.req.query("memberId");
    if (!memberId) {
      return c.json({ error: "missing_member_id" }, 400);
    }
    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

    const [latest] = await db
      .select({
        status: schema.epicVerifications.status,
        assemblySegmentClaimed: schema.epicVerifications.assemblySegmentClaimed,
        reviewedAt: schema.epicVerifications.reviewedAt,
      })
      .from(schema.epicVerifications)
      .where(eq(schema.epicVerifications.memberId, memberId))
      .orderBy(desc(schema.epicVerifications.createdAt))
      .limit(1);

    if (!latest) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json({
      status: latest.status,
      assemblySegmentClaimed: latest.assemblySegmentClaimed,
      reviewedAt: latest.reviewedAt,
    });
  });

  app.use("/review/*", async (c, next) => {
    const { ipAllowlist } = loadReviewQueueConfig(
      c.env as unknown as Record<string, string | undefined>,
    );
    return requireReviewAccess(c.env.REVIEW_QUEUE_TOKEN, ipAllowlist)(c, next);
  });

  app.get("/review/epic/queue", async (c) => {
    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

    const rows = await db
      .select()
      .from(schema.epicVerifications)
      .where(
        and(
          sql`${schema.epicVerifications.memberId} IS NOT NULL`,
          eq(schema.epicVerifications.status, "pending"),
        ),
      );

    const now = Date.now();
    const queue = await Promise.all(
      rows.map(async (row) => ({
        id: row.verificationId,
        memberId: row.memberId,
        assemblySegmentClaimed: row.assemblySegmentClaimed,
        createdAt: row.createdAt,
        overdueBySla: now - row.createdAt.getTime() > SLA_HOURS * 60 * 60 * 1000,
        epicNumber: row.epicNumberCiphertext
          ? await decryptEpicNumber(
              row.epicNumberCiphertext,
              row.epicNumberIv as string,
              c.env.EPIC_ENCRYPTION_KEY,
            )
          : null,
        docBase64: row.docCiphertext
          ? await decryptDoc(row.docCiphertext, row.docIv as string, c.env.EPIC_DOC_ENCRYPTION_KEY)
          : null,
      })),
    );

    return c.json(queue);
  });

  app.post("/review/epic/:id/approve", async (c) => {
    const id = c.req.param("id");
    const parsed = approveSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

    // Only a still-pending row may be decided — guards against a second
    // approve/reject (two reviewers racing, a replayed request) silently
    // re-transitioning and overwriting an already-recorded decision.
    const [updated] = await db
      .update(schema.epicVerifications)
      .set({
        status: "approved",
        reviewedAt: new Date(),
        assemblySegmentClaimed: parsed.data.assemblySegmentConfirmed,
        epicNumberCiphertext: null,
        epicNumberIv: null,
        docCiphertext: null,
        docIv: null,
      })
      .where(
        and(
          eq(schema.epicVerifications.verificationId, id),
          eq(schema.epicVerifications.status, "pending"),
        ),
      )
      .returning({ verificationId: schema.epicVerifications.verificationId });

    if (!updated) {
      return c.json({ error: "already_decided_or_not_found" }, 409);
    }

    return c.json({});
  });

  app.post("/review/epic/:id/reject", async (c) => {
    const id = c.req.param("id");
    const parsed = rejectSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const db = createVaultDbClient(c.env.VAULT_SVC_DATABASE_URL);

    const [updated] = await db
      .update(schema.epicVerifications)
      .set({
        status: "rejected",
        reviewedAt: new Date(),
        reviewerNote: parsed.data.reviewerNote,
        epicNumberCiphertext: null,
        epicNumberIv: null,
        docCiphertext: null,
        docIv: null,
      })
      .where(
        and(
          eq(schema.epicVerifications.verificationId, id),
          eq(schema.epicVerifications.status, "pending"),
        ),
      )
      .returning({ verificationId: schema.epicVerifications.verificationId });

    if (!updated) {
      return c.json({ error: "already_decided_or_not_found" }, 409);
    }

    return c.json({});
  });
}
