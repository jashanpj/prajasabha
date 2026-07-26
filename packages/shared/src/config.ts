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

const CORE_REQUIRED_VARS = ["CONCERN_THRESHOLD_T2", "QUORUM_PERCENT", "PANEL_TERM_MONTHS"] as const;

const CoreConfigSchema = z.object({
  concernThresholdT2: z.coerce.number().int().positive(),
  quorumPercent: z.coerce.number().min(0).max(100),
  panelTermMonths: z.coerce.number().int().positive(),
});

export type AppConfig = z.infer<typeof CoreConfigSchema>;

function missingVarsError(missing: readonly string[]): Error {
  return new Error(
    `Missing required config env var(s): ${missing.join(", ")}. Copy .env.example to .env for local dev, or set these via Wrangler vars/secrets in deployed environments.`,
  );
}

/** PRD/HLD product-law thresholds (concern threshold, quorum, panel term). */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = CORE_REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) throw missingVarsError(missing);

  return CoreConfigSchema.parse({
    concernThresholdT2: env.CONCERN_THRESHOLD_T2,
    quorumPercent: env.QUORUM_PERCENT,
    panelTermMonths: env.PANEL_TERM_MONTHS,
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
