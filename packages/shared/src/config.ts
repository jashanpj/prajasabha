import { z } from "zod";

// CLAUDE.md invariant 6: "No secrets, thresholds, or rate-limit values in
// code. Wrangler secrets / KV config only. Assume hostile readers of this
// public repo." — read strictly, with no local-dev carve-out: these
// modules must never embed real threshold numbers as a silent fallback,
// even for convenience. Every value must come from env (Wrangler vars/
// secrets in deployed environments; a gitignored `.env`, populated from
// `.env.example`, for local dev — see CONTRIBUTING.md). Every loader below
// throws if a var is missing rather than defaulting.
//
// Three separate loaders, not one combined blob — each is needed by a
// different service (apps/web needs loadConfig + loadRateLimitConfig;
// apps/vault-svc needs only loadMagicLinkConfig) — bundling them would
// force every caller to declare vars it doesn't use.

// DELIBERATION_OPEN_DAYS (issue #35 — C3) joins this bundle rather than
// getting its own loader: it's a PRD/HLD product-law threshold exactly
// like the other three, and its only consumer (support.ts's promotion CAS
// transaction) already calls loadConfig() for concernThresholdT2 — so
// bundling doesn't force any unrelated endpoint to declare a var it never
// reads (the rationale the other loaders below are split by).
const CORE_REQUIRED_VARS = [
  "CONCERN_THRESHOLD_T2",
  "QUORUM_PERCENT",
  "PANEL_TERM_MONTHS",
  "DELIBERATION_OPEN_DAYS",
] as const;

const CoreConfigSchema = z.object({
  concernThresholdT2: z.coerce.number().int().positive(),
  quorumPercent: z.coerce.number().min(0).max(100),
  panelTermMonths: z.coerce.number().int().positive(),
  deliberationOpenDays: z.coerce.number().int().positive(),
});

export type AppConfig = z.infer<typeof CoreConfigSchema>;

function missingVarsError(missing: readonly string[]): Error {
  return new Error(
    `Missing required config env var(s): ${missing.join(", ")}. Copy .env.example to .env for local dev, or set these via Wrangler vars/secrets in deployed environments.`,
  );
}

/** PRD/HLD product-law thresholds (concern threshold, quorum, panel term, deliberation window). */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = CORE_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return CoreConfigSchema.parse({
    concernThresholdT2: env.CONCERN_THRESHOLD_T2,
    quorumPercent: env.QUORUM_PERCENT,
    panelTermMonths: env.PANEL_TERM_MONTHS,
    deliberationOpenDays: env.DELIBERATION_OPEN_DAYS,
  });
}

// Issue #20 — A1 magic-link registration. Numbers are reasonable MVP
// defaults (no doc specifies concrete figures; HLD A7 only says "strict
// rate limits" qualitatively), not sourced from product law — tune via
// env, never hardcode a comparison against these at a call site.

const MAGIC_LINK_REQUIRED_VARS = ["MAGIC_LINK_TTL_MINUTES"] as const;

const MagicLinkConfigSchema = z.object({
  magicLinkTtlMinutes: z.coerce.number().int().positive(),
});

export type MagicLinkConfig = z.infer<typeof MagicLinkConfigSchema>;

/** Magic-link token TTL — used by apps/vault-svc when minting a token. */
export function loadMagicLinkConfig(env: Record<string, string | undefined>): MagicLinkConfig {
  const missing = MAGIC_LINK_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return MagicLinkConfigSchema.parse({ magicLinkTtlMinutes: env.MAGIC_LINK_TTL_MINUTES });
}

const RATE_LIMIT_REQUIRED_VARS = [
  "REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR",
  "REGISTER_RATE_LIMIT_PER_IP_PER_HOUR",
  "VERIFY_RATE_LIMIT_PER_IP_PER_HOUR",
] as const;

const RateLimitConfigSchema = z.object({
  registerRateLimitPerEmailPerHour: z.coerce.number().int().positive(),
  registerRateLimitPerIpPerHour: z.coerce.number().int().positive(),
  verifyRateLimitPerIpPerHour: z.coerce.number().int().positive(),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/** Registration/verify rate-limit numbers — used by apps/web's endpoints. */
export function loadRateLimitConfig(env: Record<string, string | undefined>): RateLimitConfig {
  const missing = RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return RateLimitConfigSchema.parse({
    registerRateLimitPerEmailPerHour: env.REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR,
    registerRateLimitPerIpPerHour: env.REGISTER_RATE_LIMIT_PER_IP_PER_HOUR,
    verifyRateLimitPerIpPerHour: env.VERIFY_RATE_LIMIT_PER_IP_PER_HOUR,
  });
}

// Issue #22 — A3 T2 verification (EPIC / Voter ID → constituency mapping).
// `/public/epic/submit` (apps/vault-svc) is reachable with no
// service-to-service auth at all (only Turnstile, same as
// register/start.ts) and apps/web's own /api/verify/epic/submit is the
// one call that can reveal "already verified by someone else" — both need
// the same KV-backed rate-limit treatment start.ts already gets. Two
// separate loaders, not one combined blob (same reasoning as
// loadMagicLinkConfig/loadRateLimitConfig above): each is needed by a
// different service, and bundling them would force apps/web to also
// declare vault-svc's own rate-limit var it never reads, or vice versa.

const EPIC_SUBMIT_RATE_LIMIT_REQUIRED_VARS = ["EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR"] as const;

const EpicSubmitRateLimitConfigSchema = z.object({
  epicSubmitRateLimitPerIpPerHour: z.coerce.number().int().positive(),
});

export type EpicSubmitRateLimitConfig = z.infer<typeof EpicSubmitRateLimitConfigSchema>;

/** apps/vault-svc's /public/epic/submit per-IP rate limit. */
export function loadEpicSubmitRateLimitConfig(
  env: Record<string, string | undefined>,
): EpicSubmitRateLimitConfig {
  const missing = EPIC_SUBMIT_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return EpicSubmitRateLimitConfigSchema.parse({
    epicSubmitRateLimitPerIpPerHour: env.EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR,
  });
}

const EPIC_LINK_RATE_LIMIT_REQUIRED_VARS = ["EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR"] as const;

const EpicLinkRateLimitConfigSchema = z.object({
  epicLinkRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type EpicLinkRateLimitConfig = z.infer<typeof EpicLinkRateLimitConfigSchema>;

/** apps/web's /api/verify/epic/submit per-member rate limit. */
export function loadEpicLinkRateLimitConfig(
  env: Record<string, string | undefined>,
): EpicLinkRateLimitConfig {
  const missing = EPIC_LINK_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return EpicLinkRateLimitConfigSchema.parse({
    epicLinkRateLimitPerMemberPerHour: env.EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

// Two more loaders, same "no silent fallback" posture as the three above.

const commaSeparatedList = z
  .string()
  .transform((value) => value.split(",").map((entry) => entry.trim()));

const REVIEW_QUEUE_REQUIRED_VARS = ["REVIEW_QUEUE_IP_ALLOWLIST"] as const;

const ReviewQueueConfigSchema = z.object({
  ipAllowlist: commaSeparatedList,
});

export type ReviewQueueConfig = z.infer<typeof ReviewQueueConfigSchema>;

/**
 * apps/vault-svc's /review/epic/* IP allowlist — used by requireReviewAccess
 * (review-auth.ts) to gate the review queue, which is deliberately a
 * separate auth path from VAULT_SVC_INTERNAL_TOKEN (see #22's test notes).
 */
export function loadReviewQueueConfig(env: Record<string, string | undefined>): ReviewQueueConfig {
  const missing = REVIEW_QUEUE_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return ReviewQueueConfigSchema.parse({ ipAllowlist: env.REVIEW_QUEUE_IP_ALLOWLIST });
}

const EPIC_VERIFICATION_REQUIRED_VARS = [
  "PILOT_CONSTITUENCY_NAME_ML",
  "PILOT_CONSTITUENCY_NAME_EN",
  "COVERED_ASSEMBLY_SEGMENTS",
] as const;

const EpicVerificationConfigSchema = z.object({
  pilotConstituencyNameMl: z.string().min(1),
  pilotConstituencyNameEn: z.string().min(1),
  coveredAssemblySegments: commaSeparatedList,
});

export type EpicVerificationConfig = z.infer<typeof EpicVerificationConfigSchema>;

/**
 * The pilot's single Lok Sabha constituency display name (ml/en) plus the
 * allow-list of assembly segments already onboarded — used by apps/web's
 * verify/epic/status endpoint to decide the "T2 badge shows constituency
 * name" vs. "mismatched constituency... coming soon" AC. No constituencies
 * table exists (the whole pilot targets one constituency); this is
 * deliberately config, not schema, same pattern as concernThresholdT2.
 */
export function loadEpicVerificationConfig(
  env: Record<string, string | undefined>,
): EpicVerificationConfig {
  const missing = EPIC_VERIFICATION_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return EpicVerificationConfigSchema.parse({
    pilotConstituencyNameMl: env.PILOT_CONSTITUENCY_NAME_ML,
    pilotConstituencyNameEn: env.PILOT_CONSTITUENCY_NAME_EN,
    coveredAssemblySegments: env.COVERED_ASSEMBLY_SEGMENTS,
  });
}

// Issue #24 — B1 "Raise an Issue" form. Both are the "config, not schema"
// treatment: no categories/wards lookup table exists (packages/db's
// issues.category is deliberately free text — data-driven taxonomy, HLD
// §6 — and the pilot targets a single constituency's wards), so the
// allow-lists live in env, same pattern as loadEpicVerificationConfig
// above. publish.ts validates a draft's saved category/wardId against
// these before flipping status to 'published'.

const ISSUE_CATEGORIES_REQUIRED_VARS = ["ISSUE_CATEGORIES"] as const;

const IssueCategoriesConfigSchema = z.object({
  issueCategories: commaSeparatedList,
});

export type IssueCategoriesConfig = z.infer<typeof IssueCategoriesConfigSchema>;

/** The configured issue-category allow-list (comma-separated codes). */
export function loadIssueCategoriesConfig(
  env: Record<string, string | undefined>,
): IssueCategoriesConfig {
  const missing = ISSUE_CATEGORIES_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssueCategoriesConfigSchema.parse({ issueCategories: env.ISSUE_CATEGORIES });
}

const PILOT_WARDS_REQUIRED_VARS = [
  "PILOT_WARD_IDS",
  "PILOT_WARD_NAMES_ML",
  "PILOT_WARD_NAMES_EN",
] as const;

const PilotWardSchema = z.object({
  id: z.string().uuid(),
  nameMl: z.string().min(1),
  nameEn: z.string().min(1),
});

export interface PilotWardsConfig {
  pilotWards: z.infer<typeof PilotWardSchema>[];
}

/**
 * The pilot's ward allow-list: three index-aligned comma-separated env
 * lists (ids, Malayalam names, English names) zipped into one array. The
 * names exist so the form's ward <select> renders bilingual labels without
 * a wards table; the ids are what issues.ward_id stores and what
 * publish-time validation checks.
 */
export function loadPilotWardsConfig(env: Record<string, string | undefined>): PilotWardsConfig {
  const missing = PILOT_WARDS_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  const ids = commaSeparatedList.parse(env.PILOT_WARD_IDS);
  const namesMl = commaSeparatedList.parse(env.PILOT_WARD_NAMES_ML);
  const namesEn = commaSeparatedList.parse(env.PILOT_WARD_NAMES_EN);

  if (ids.length !== namesMl.length || ids.length !== namesEn.length) {
    throw new Error(
      `Pilot-wards config lists are not index-aligned: PILOT_WARD_IDS has ${ids.length} entries, PILOT_WARD_NAMES_ML has ${namesMl.length}, PILOT_WARD_NAMES_EN has ${namesEn.length}.`,
    );
  }

  const pilotWards = ids.map((id, index) =>
    PilotWardSchema.parse({ id, nameMl: namesMl[index], nameEn: namesEn[index] }),
  );

  return { pilotWards };
}

// Issue #24's four mutation endpoints (create/draft/photos/publish) are
// session-authed, not anonymous like registration — so no Turnstile, but
// every other mutation endpoint in this codebase (register/start.ts,
// verify/epic/submit.ts) still rate-limits, and photos.ts in particular
// runs CPU-bound EXIF parsing plus an R2 write per call, so it needs a
// throttle at least as much as those do. Per-member (not per-IP): the
// session cookie already ties every call to one member_id, and there is
// no enumeration risk here the way there is on register (no anon caller
// can probe for "does this member exist").

// Four separate loaders, not one bundled config — unlike loadRateLimitConfig
// (register's ip+email limits, both consumed by the SAME start.ts), each of
// these is read by a DIFFERENT endpoint file (create.ts/draft.ts/photos.ts/
// publish.ts), so bundling would force e.g. draft.ts's tests to also stub
// photos.ts's limit. Same reasoning as loadEpicSubmitRateLimitConfig vs.
// loadEpicLinkRateLimitConfig being split by consumer.

const ISSUE_CREATE_RATE_LIMIT_REQUIRED_VARS = [
  "ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const IssueCreateRateLimitConfigSchema = z.object({
  issueCreateRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type IssueCreateRateLimitConfig = z.infer<typeof IssueCreateRateLimitConfigSchema>;

/** apps/web's POST /api/issues/create per-member hourly limit. */
export function loadIssueCreateRateLimitConfig(
  env: Record<string, string | undefined>,
): IssueCreateRateLimitConfig {
  const missing = ISSUE_CREATE_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssueCreateRateLimitConfigSchema.parse({
    issueCreateRateLimitPerMemberPerHour: env.ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

const ISSUE_DRAFT_RATE_LIMIT_REQUIRED_VARS = [
  "ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const IssueDraftRateLimitConfigSchema = z.object({
  issueDraftRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type IssueDraftRateLimitConfig = z.infer<typeof IssueDraftRateLimitConfigSchema>;

/** apps/web's PATCH /api/issues/:issueId/draft per-member hourly limit. */
export function loadIssueDraftRateLimitConfig(
  env: Record<string, string | undefined>,
): IssueDraftRateLimitConfig {
  const missing = ISSUE_DRAFT_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssueDraftRateLimitConfigSchema.parse({
    issueDraftRateLimitPerMemberPerHour: env.ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

const ISSUE_PHOTO_RATE_LIMIT_REQUIRED_VARS = [
  "ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const IssuePhotoRateLimitConfigSchema = z.object({
  issuePhotoRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type IssuePhotoRateLimitConfig = z.infer<typeof IssuePhotoRateLimitConfigSchema>;

/** apps/web's POST /api/issues/:issueId/photos per-member hourly limit. */
export function loadIssuePhotoRateLimitConfig(
  env: Record<string, string | undefined>,
): IssuePhotoRateLimitConfig {
  const missing = ISSUE_PHOTO_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssuePhotoRateLimitConfigSchema.parse({
    issuePhotoRateLimitPerMemberPerHour: env.ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

const ISSUE_PUBLISH_RATE_LIMIT_REQUIRED_VARS = [
  "ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const IssuePublishRateLimitConfigSchema = z.object({
  issuePublishRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type IssuePublishRateLimitConfig = z.infer<typeof IssuePublishRateLimitConfigSchema>;

/** apps/web's POST /api/issues/:issueId/publish per-member hourly limit. */
export function loadIssuePublishRateLimitConfig(
  env: Record<string, string | undefined>,
): IssuePublishRateLimitConfig {
  const missing = ISSUE_PUBLISH_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssuePublishRateLimitConfigSchema.parse({
    issuePublishRateLimitPerMemberPerHour: env.ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

// Issue #25 — B2 "flag misrouting" endpoint. Same per-member (not per-IP)
// treatment as issue #24's four loaders above (session-authed, no
// enumeration risk), added here as a fifth separate loader rather than
// folded into any of the above — this endpoint's file is distinct from
// create.ts/draft.ts/photos.ts/publish.ts, so the same "bundling forces
// unrelated tests to stub each other's limits" reasoning applies.

const FLAG_ROUTING_RATE_LIMIT_REQUIRED_VARS = [
  "FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const FlagRoutingRateLimitConfigSchema = z.object({
  flagRoutingRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type FlagRoutingRateLimitConfig = z.infer<typeof FlagRoutingRateLimitConfigSchema>;

/** apps/web's "flag misrouting" endpoint per-member hourly limit (issue #25 — B2). */
export function loadFlagRoutingRateLimitConfig(
  env: Record<string, string | undefined>,
): FlagRoutingRateLimitConfig {
  const missing = FLAG_ROUTING_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return FlagRoutingRateLimitConfigSchema.parse({
    flagRoutingRateLimitPerMemberPerHour: env.FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

// Issue #26 — B3 Support & Dedup.

const ISSUE_SUPPORT_RATE_LIMIT_REQUIRED_VARS = [
  "ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR",
] as const;

const IssueSupportRateLimitConfigSchema = z.object({
  issueSupportRateLimitPerMemberPerHour: z.coerce.number().int().positive(),
});

export type IssueSupportRateLimitConfig = z.infer<typeof IssueSupportRateLimitConfigSchema>;

/** apps/web's POST /api/issues/:issueId/support per-member hourly limit. */
export function loadIssueSupportRateLimitConfig(
  env: Record<string, string | undefined>,
): IssueSupportRateLimitConfig {
  const missing = ISSUE_SUPPORT_RATE_LIMIT_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssueSupportRateLimitConfigSchema.parse({
    issueSupportRateLimitPerMemberPerHour: env.ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR,
  });
}

// B3's admin-only merge endpoint. There is no admin-role model anywhere in
// this codebase yet, so this mirrors apps/vault-svc's loadReviewQueueConfig
// comma-separated IP allowlist pattern almost verbatim, plus a required
// non-empty bearer token — the second, independent factor
// requireAdminAccess checks (apps/web/src/lib/admin-auth.ts), so a leaked
// merge-admin token alone can't grant access from a non-allow-listed IP,
// and vice versa (same two-factor posture as vault-svc's
// requireReviewAccess).

const ISSUE_MERGE_ADMIN_REQUIRED_VARS = [
  "ISSUE_MERGE_ADMIN_TOKEN",
  "ISSUE_MERGE_ADMIN_IP_ALLOWLIST",
] as const;

const IssueMergeAdminConfigSchema = z.object({
  adminToken: z.string().min(1),
  ipAllowlist: commaSeparatedList,
});

export type IssueMergeAdminConfig = z.infer<typeof IssueMergeAdminConfigSchema>;

/** apps/web's POST /api/admin/issues/:issueId/merge bearer token + IP allowlist. */
export function loadIssueMergeAdminConfig(
  env: Record<string, string | undefined>,
): IssueMergeAdminConfig {
  const missing = ISSUE_MERGE_ADMIN_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return IssueMergeAdminConfigSchema.parse({
    adminToken: env.ISSUE_MERGE_ADMIN_TOKEN,
    ipAllowlist: env.ISSUE_MERGE_ADMIN_IP_ALLOWLIST,
  });
}

// Issue #35/#34 (C3/C2) — the consensus agreement threshold and minimum
// sample size are PRD-adjacent product thresholds ("Broad agreement" is
// >=70% across >= a configurable N voters, per #34's own AC), so they get
// the same "no silent fallback" env-driven treatment as concernThresholdT2
// rather than a hardcoded 70/N literal (CLAUDE.md invariant 6). Split from
// loadConfig() because this is consumed by a different set of files
// (apps/jobs' lifecycle-sweep.ts starting in this PR, then apps/web's
// consensus endpoint/page in #34) than support.ts's promotion bundle.

const CONSENSUS_REQUIRED_VARS = [
  "CONSENSUS_AGREEMENT_THRESHOLD_PERCENT",
  "CONSENSUS_MIN_VOTERS",
] as const;

const ConsensusConfigSchema = z.object({
  agreementThresholdPercent: z.coerce.number().min(0).max(100),
  minVoters: z.coerce.number().int().positive(),
});

export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>;

/** The "Broad agreement" threshold (>=X% across >=N voters) — issue #34's C2. */
export function loadConsensusConfig(env: Record<string, string | undefined>): ConsensusConfig {
  const missing = CONSENSUS_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return ConsensusConfigSchema.parse({
    agreementThresholdPercent: env.CONSENSUS_AGREEMENT_THRESHOLD_PERCENT,
    minVoters: env.CONSENSUS_MIN_VOTERS,
  });
}

// Issue #35's demo-only manual sweep trigger (apps/web's
// POST /api/admin/deliberations/sweep) — lets a stakeholder demo walk
// through Open->Closed->Summarized same-day instead of waiting on the real
// cron window. Same two-factor bearer-token + IP-allowlist shape as
// loadIssueMergeAdminConfig, deliberately a separate loader/separate env
// vars (not reused) since it gates a different endpoint with its own
// blast radius (manually force-closing deliberations, not merging issues).

const DELIBERATION_SWEEP_ADMIN_REQUIRED_VARS = [
  "DELIBERATION_SWEEP_ADMIN_TOKEN",
  "DELIBERATION_SWEEP_ADMIN_IP_ALLOWLIST",
] as const;

const DeliberationSweepAdminConfigSchema = z.object({
  adminToken: z.string().min(1),
  ipAllowlist: commaSeparatedList,
});

export type DeliberationSweepAdminConfig = z.infer<typeof DeliberationSweepAdminConfigSchema>;

/** apps/web's POST /api/admin/deliberations/sweep bearer token + IP allowlist (demo tooling). */
export function loadDeliberationSweepAdminConfig(
  env: Record<string, string | undefined>,
): DeliberationSweepAdminConfig {
  const missing = DELIBERATION_SWEEP_ADMIN_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return DeliberationSweepAdminConfigSchema.parse({
    adminToken: env.DELIBERATION_SWEEP_ADMIN_TOKEN,
    ipAllowlist: env.DELIBERATION_SWEEP_ADMIN_IP_ALLOWLIST,
  });
}
