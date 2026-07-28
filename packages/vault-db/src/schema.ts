// Identity-vault schema (packages/vault-db). Never imported by apps/web,
// apps/api, or apps/jobs — enforced by packages/shared/src/lint/vault-isolation
// plus the schema-guard subagent. Only apps/vault-svc imports this package.
//
// Scope, in the order these landed:
//   - auth_credentials  (#20) — T0 email magic-link registration
//   - epic_verifications (#16/#22) — T2 EPIC/voter-ID verification records
//   - access_log        (#23) — append-only audit of every vault read
// Aadhaar/T1 records are still unbuilt (#21 is postponed; see todo.md).
//
// The whole-of-vault property worth holding in mind when adding a table here:
// epic_verifications.member_id is the ONLY vault->participation link that
// exists. auth_credentials deliberately stores a bare `linked` boolean rather
// than a member_id, and access_log records vault row ids. Adding a second
// member_id-bearing table widens the blast radius documented in
// docs/vault-blast-radius.md, so it needs a deliberate decision, not a
// convenient column.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Explicit schema object (not relying on connection search_path) so table
// creation is correct regardless of which schema the connecting role's
// search_path defaults to — local dev's VAULT_DATABASE_URL sets
// search_path=vault as a convenience, but that must not be the only thing
// keeping these tables out of `public`.
export const vault = pgSchema("vault");

// RLS is deliberately NOT modelled here. Every table's `ENABLE ROW LEVEL
// SECURITY`, its policies, and its GRANT/REVOKE live hand-written in the
// migration that creates it (invariant 4), so the drizzle snapshots record
// `isRLSEnabled: false` / `policies: {}` for all three vault tables. That
// disagrees with the database on purpose. Do not "fix" it by adding
// `.enableRLS()` or `pgPolicy(...)` to this file: drizzle would then emit a
// duplicate ENABLE/CREATE POLICY against an already-migrated database and
// error. If that changes, it has to change for all three tables in one
// migration.

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

// Vault access log (issue #23 / A4). HLD §4.1: "All vault reads append to an
// access log alerting to founders"; the Security Design doc names vault access
// alerting as the primary control against an insider or compromised admin.
// Nothing logged vault reads before this table existed.
//
// APPEND-ONLY, and the only append-only table in the vault. An audit log that
// the role holding the reads can also rewrite is not an audit log, so
// migration 0002 grants vault_role SELECT + INSERT only and then explicitly
// REVOKEs UPDATE/DELETE — the same belt-and-suspenders shape
// packages/db uses for event_log and moderation_actions (CLAUDE.md
// invariant 3). Corrections are new rows.
//
// INVARIANT 1 APPLIES WITH FULL FORCE HERE. This table lives in the vault, so
// it may reference identity rows — but it must never acquire a
// civic-activity attribute. A row here says *that* identity data was read, by
// which gate, and how much — never what the member did, and never the data
// itself.
//
// That is enforced at the DATABASE level, not just by convention, because a
// review-time comment is the wrong control for the one table where a civic id
// could most plausibly be added "just for debugging":
//   - `operation` is a pgEnum, so recording e.g. 'issue.support.read' is a
//     constraint violation, not a code-review discussion. Adding a genuine new
//     vault operation therefore requires a migration — deliberately: a new way
//     to read the vault deserves that much friction.
//   - there is NO free-form jsonb column. An earlier draft had a `detail`
//     jsonb bag; it was removed because nothing wrote to it and a
//     `{ issueId }` inside a jsonb blob would pass every column-name-based
//     test in the repo while putting a civic id in the identity vault.
//     Add structured columns when something needs them.
//
// Deliberately NOT recorded: IP address, bearer token, or any decrypted
// value. Those would turn the audit trail into a second copy of the thing it
// is auditing.
export const vaultAccessOperationEnum = vault.enum("vault_access_operation", [
  "registration.start.duplicate_check",
  "registration.consume",
  "registration.complete.lookup",
  "epic.link.lookup",
  "epic.status",
  "epic.review_queue",
]);

// Which authorisation gate admitted the caller: 'internal' (bearer
// VAULT_SVC_INTERNAL_TOKEN) or 'review' (bearer REVIEW_QUEUE_TOKEN + IP
// allowlist). The gate, never the token and never the caller's IP.
export const vaultAccessCallerEnum = vault.enum("vault_access_caller", ["internal", "review"]);

// `denied` is reserved and currently unwritten: rejections by the bearer-token
// or IP-allowlist gates deliberately log NOTHING (an unauthenticated caller must
// not be able to append rows and bury a real read — asserted in
// apps/vault-svc/src/access-log.test.ts). It exists for a future in-handler
// authorization denial, i.e. a caller who passed the gate but was refused a
// specific row.
export const vaultAccessOutcomeEnum = vault.enum("vault_access_outcome", [
  "ok",
  "not_found",
  "denied",
]);

export const accessLog = vault.table(
  "access_log",
  {
    accessId: uuid("access_id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    operation: vaultAccessOperationEnum("operation").notNull(),
    // The VAULT ROW touched — epic_verifications.verification_id or
    // auth_credentials.id. Deliberately not a member_id: schema.ts's header
    // states epic_verifications.member_id is the only vault->participation
    // link in the system, and docs/vault-blast-radius.md leans on that, so
    // this column must not quietly become a second one. Nullable, because a
    // bulk read has no single subject and records rowCount instead.
    subjectRef: uuid("subject_ref"),
    caller: vaultAccessCallerEnum("caller").notNull(),
    outcome: vaultAccessOutcomeEnum("outcome").notNull(),
    // How many identity rows the caller was actually exposed to. This is the
    // column that makes a bulk read visible: /review/epic/queue decrypts
    // every pending row's EPIC number AND document in one call, so a spike
    // here is the signal worth alerting on.
    rowCount: integer("row_count").notNull(),
  },
  (t) => [
    // The two read patterns a reviewer or an incident responder needs:
    // "what happened recently" and "everything touching this subject".
    index("access_log_at_idx").on(t.at),
    index("access_log_subject_ref_idx").on(t.subjectRef),
  ],
);
