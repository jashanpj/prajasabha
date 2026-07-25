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
});
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

// A3: EPIC (voter ID) submission for T2 upgrade. Only carries member_id +
// an opaque doc reference — never the EPIC number or document itself
// alongside civic-activity data (vault join rule, CLAUDE.md invariant 1).
// The actual EPIC value and verification record are vault-svc's concern
// (packages/vault-db, issue #16), not packages/db's.
export const epicVerificationSubmissionSchema = z.object({
  memberId: z.string().uuid(),
  epicNo: z.string().min(6).max(20),
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

// B3/B4: issue support ("concern") action — dedup enforced at the DB layer
// via issue_support's unique(issue_id, member_id) constraint.
export const issueSupportActionSchema = z.object({
  issueId: z.string().uuid(),
  memberId: z.string().uuid(),
});
export type IssueSupportAction = z.infer<typeof issueSupportActionSchema>;
