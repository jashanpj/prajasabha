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
