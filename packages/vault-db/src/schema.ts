// Identity-vault schema (packages/vault-db). Never imported by apps/web,
// apps/api, or apps/jobs — enforced by packages/shared/src/lint/vault-isolation
// plus the schema-guard subagent. Only apps/vault-svc imports this package.
//
// Scope: issue #20's auth_credentials table only — a narrowly-scoped store
// for T0 email magic-link registration. The full identity-vault schema
// (Aadhaar/EPIC verification records, T1/T2) lands separately in issue #16
// and does not depend on this table.
import { sql } from "drizzle-orm";
import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Explicit schema object (not relying on connection search_path) so table
// creation is correct regardless of which schema the connecting role's
// search_path defaults to — local dev's VAULT_DATABASE_URL sets
// search_path=vault as a convenience, but that must not be the only thing
// keeping these tables out of `public`.
export const vault = pgSchema("vault");

export const authCredentials = vault.table(
  "auth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deterministic HMAC-SHA256(EMAIL_HASH_PEPPER, normalizeEmail(email)) —
    // equality-lookup only, never reversible. See crypto.ts. A distinct
    // secret from emailCiphertext's encryption key (never reuse a key for
    // two purposes).
    emailHash: text("email_hash").notNull(),
    // AES-GCM ciphertext (base64, includes the auth tag) — see crypto.ts.
    // Decrypted only by a future admin/export feature; issue #20 never
    // calls decryptEmail() itself.
    emailCiphertext: text("email_ciphertext").notNull(),
    // AES-GCM IV (base64, 12 random bytes, fresh per row — never reused
    // with the same key).
    emailIv: text("email_iv").notNull(),
    // Staged at request time; copied into packages/db.members on success,
    // then this row's job is done — never updated with the resulting
    // member_id. Deliberately: vault-db must never be able to answer
    // "which member does this email belong to" (CLAUDE.md invariant 1's
    // vault join rule applies to the *purpose* of the split, not just its
    // literal column list — a permanent email-to-member_id correlation
    // sitting in the identity vault is exactly what the two-database
    // architecture exists to prevent). No FK to packages/db either way —
    // vault-db and packages/db are logically (and in production,
    // physically) separate databases.
    pseudonym: text("pseudonym").notNull(),
    locale: text("locale").notNull(), // 'ml' | 'en'
    // SHA-256(raw magic-link token), hex — never the raw token itself,
    // same posture as a password-reset token.
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Set true once packages/db's member insert succeeds (apps/vault-svc's
    // "complete" call) — a bare boolean, not the member_id itself. Stays
    // false forever if the flow was abandoned after consuming the token
    // (e.g. a pseudonym race lost the insert): an accepted, logged (via
    // packages/db's event_log) orphan for issue #20's scope, and — because
    // this is a bare flag, not the member_id — one that never blocks that
    // email from registering again if they never actually completed.
    linked: boolean("linked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_credentials_email_hash_idx").on(t.emailHash),
    index("auth_credentials_token_hash_idx").on(t.tokenHash),
    // Partial unique index: only ONE *linked* (completed) registration may
    // exist per email hash — the real, race-safe "duplicate email
    // blocked" guarantee (unlike an app-level SELECT-then-INSERT check).
    // Multiple pending/expired/abandoned rows for the same email are
    // still allowed (re-registration attempts, resends).
    uniqueIndex("auth_credentials_email_hash_linked_uniq")
      .on(t.emailHash)
      .where(sql`${t.linked} = true`),
  ],
);

// Issue #16/#22 — A3 EPIC (voter ID) verification records for T2 tier.
// member_id -> verification record only, no civic-activity columns
// (CLAUDE.md invariant 1 / issue #16's AC). `memberId` is nullable: a row
// is created by the public browser->vault-svc submit step before any
// member is attached (mirrors auth_credentials' "insert now, attach
// identity later" shape), then linked by apps/web's own session-authed
// call once it knows which member_id is submitting.
export const epicVerificationStatusEnum = vault.enum("epic_verification_status", [
  "pending",
  "approved",
  "rejected",
]);

export const epicVerifications = vault.table(
  "epic_verifications",
  {
    verificationId: uuid("verification_id").primaryKey().defaultRandom(),
    memberId: uuid("member_id"),
    // HMAC-SHA256(EPIC_HASH_PEPPER, normalizeEpicNumber(epicNumber)) — see
    // crypto.ts. Equality-lookup only, never reversible; the partial
    // unique index below on this column (WHERE status = 'approved') is
    // issue #22's AC4 "one EPIC number = one account" as a real DB
    // constraint, not an app-level check.
    epicNumberHash: text("epic_number_hash").notNull(),
    // AES-GCM ciphertext/IV (EPIC_ENCRYPTION_KEY — distinct from both
    // auth_credentials' email key and this table's own doc key, never
    // reused across purposes). Nulled by the reviewer's approve/reject
    // decision — see epic.ts — leaving only the hash behind.
    epicNumberCiphertext: text("epic_number_ciphertext"),
    epicNumberIv: text("epic_number_iv"),
    // AES-GCM ciphertext/IV over the uploaded document/photo blob
    // (EPIC_DOC_ENCRYPTION_KEY — a third, distinct secret). Nulled on
    // review decision too — HLD §4.3's "photo docs deleted on decision".
    docCiphertext: text("doc_ciphertext"),
    docIv: text("doc_iv"),
    assemblySegmentClaimed: text("assembly_segment_claimed").notNull(),
    status: epicVerificationStatusEnum("status").notNull().default("pending"),
    reviewerNote: text("reviewer_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    index("epic_verifications_hash_idx").on(t.epicNumberHash),
    index("epic_verifications_member_id_idx").on(t.memberId),
    // Partial unique index: only ONE *approved* verification may exist per
    // EPIC-number hash — mirrors auth_credentials_email_hash_linked_uniq's
    // WHERE-linked=true pattern exactly. Multiple pending/rejected rows for
    // the same hash are still allowed (resubmission after rejection,
    // concurrent review) — a collision at submit time routes to a support
    // flow (see epic.ts's /internal/epic/link), it does not silently fail.
    uniqueIndex("epic_verifications_hash_approved_uniq")
      .on(t.epicNumberHash)
      .where(sql`${t.status} = 'approved'`),
  ],
);
