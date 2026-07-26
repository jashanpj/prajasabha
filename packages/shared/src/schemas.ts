import { z } from "zod";

// Zod schemas for the core mutation payloads used by M1 stories (A1-A4,
// B1-B4), per issue #17. No apps/api endpoints exist yet — these validate
// payload *shape* only, independent of any DB coupling, so both apps/web
// (endpoint bodies) and apps/jobs can import them without depending on
// packages/db. Endpoint-specific concerns (authz, rate limiting, RLS) are
// added per-endpoint as each module lands.

// A1: T0 registration request — email magic-link, not phone-OTP. HLD §2's
// A1 amendment and PRD Risk #10 already documented email as T0's fallback;
// issue #20 resequenced it to be the primary path (phone-OTP deferred
// behind spike #7 / chore #12, not cancelled — see todo.md's Phase 0
// context note). Pseudonym is chosen at signup, validated against a
// profanity/party-name filter at the endpoint layer (not expressible as a
// static Zod pattern here).
export const registrationRequestSchema = z.object({
  email: z.string().email(),
  pseudonym: z.string().min(3).max(32),
  locale: z.enum(["ml", "en"]),
  turnstileToken: z.string().min(1),
});
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

// A3: EPIC (voter ID) verification submission for T2 upgrade — deliberately
// narrow. `memberId` is the exact join key used everywhere in packages/db
// to attribute civic activity (issue_support.member_id, issues.created_by,
// event_log.actor_member_id); the vault join rule (CLAUDE.md invariant 1)
// forbids any *type*, not just any table, that pairs an identity attribute
// with it. The raw EPIC number is therefore never expressed in this
// schema, which lives in packages/shared and is importable from apps/web,
// apps/api, and apps/jobs alike — a joined shape here could get reused as
// a log/analytics payload later. `docRef` is an opaque, already-uploaded
// document/session reference (vault-svc issues it); the client submits the
// EPIC number itself directly to a vault-svc-scoped endpoint/schema that
// does not live in packages/shared (packages/vault-db, issue #16, out of
// scope here).
export const epicVerificationSubmissionSchema = z.object({
  memberId: z.string().uuid(),
  docRef: z.string().min(1),
});
export type EpicVerificationSubmission = z.infer<typeof epicVerificationSubmissionSchema>;

// B1: issue creation.
export const issueCreateSchema = z.object({
  titleMl: z.string().min(1).max(200),
  titleEn: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  // Validated against a config-sourced category allow-list at the call
  // site — packages/db/src/schema.ts keeps `category` as free text
  // (data-driven taxonomy, HLD §6), so this schema only enforces
  // "non-empty", not a hardcoded enum that would need a code deploy to
  // extend.
  category: z.string().min(1),
  wardId: z.string().uuid(),
});
export type IssueCreate = z.infer<typeof issueCreateSchema>;

// B1: debounced autosave PATCH body (issue #24). A straight .partial() of
// issueCreateSchema: every field optional (an empty object is a valid
// no-op autosave tick), but any field that IS present stays bound by
// issueCreateSchema's own rules — an autosaved empty title is rejected at
// the boundary, not silently persisted and caught only at publish time.
export const issueDraftUpdateSchema = issueCreateSchema.partial();
export type IssueDraftUpdate = z.infer<typeof issueDraftUpdateSchema>;

// B1: evidence-photo upload body (issue #24). Content validation (magic-
// byte mime sniffing, the 5-photo cap, EXIF stripping) happens at the
// endpoint — this schema only enforces payload shape. `filename` is used
// for nothing security-relevant (the stored key is a server-generated
// uuid + sniffed extension); it exists for error messages and the form UI.
export const issuePhotoUploadSchema = z.object({
  photoBase64: z.string().min(1),
  filename: z.string().min(1),
});
export type IssuePhotoUpload = z.infer<typeof issuePhotoUploadSchema>;

// B3/B4: issue support ("concern") action — dedup enforced at the DB layer
// via issue_support's unique(issue_id, member_id) constraint.
export const issueSupportActionSchema = z.object({
  issueId: z.string().uuid(),
  memberId: z.string().uuid(),
});
export type IssueSupportAction = z.infer<typeof issueSupportActionSchema>;

// C1: statement submission (issue #33). "<=280 chars" is the story's own
// literal text — a fixed content-shape constant (same category as B1's
// 5-photo cap), not a tunable product threshold, so it's a plain literal
// here rather than config-driven, and not a DB CHECK either (same "bakes a
// product threshold into the schema" reasoning as photoKeys' cap).
export const statementCreateSchema = z.object({
  body: z.string().min(1).max(280),
});
export type StatementCreate = z.infer<typeof statementCreateSchema>;

// C1: Agree/Disagree/Pass vote on a statement.
export const statementVoteActionSchema = z.object({
  vote: z.enum(["agree", "disagree", "pass"]),
});
export type StatementVoteAction = z.infer<typeof statementVoteActionSchema>;

// C1: minimal admin-gated moderation action (mirrors #26's merge endpoint
// pattern — Module H's real moderation console, issue #29, doesn't exist
// yet). `ruleCited`/`publicNote` map directly onto the existing
// moderationActions table's own columns.
export const statementModerationActionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  ruleCited: z.string().min(1),
  publicNote: z.string().max(500).optional(),
});
export type StatementModerationAction = z.infer<typeof statementModerationActionSchema>;
