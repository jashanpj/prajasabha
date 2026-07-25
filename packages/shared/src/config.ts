import { z } from "zod";

// CLAUDE.md invariant 6: "No secrets, thresholds, or rate-limit values in
// code. Wrangler secrets / KV config only. Assume hostile readers of this
// public repo." — read strictly, with no local-dev carve-out: this module
// must never embed the real concern-threshold/quorum/panel-term numbers as
// a silent fallback, even for convenience. Every value must come from env
// (Wrangler vars/secrets in deployed environments; a gitignored `.env`,
// populated from `.env.example`, for local dev — see CONTRIBUTING.md).
// loadConfig throws if a var is missing rather than defaulting.
const REQUIRED_VARS = ["CONCERN_THRESHOLD_T2", "QUORUM_PERCENT", "PANEL_TERM_MONTHS"] as const;

const ConfigSchema = z.object({
  concernThresholdT2: z.coerce.number().int().positive(),
  quorumPercent: z.coerce.number().min(0).max(100),
  panelTermMonths: z.coerce.number().int().positive(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Resolves config-driven constants from env. `env` is passed explicitly
 * (never read from `process.env` internally) because Cloudflare Workers
 * have no `process.env` — callers pass the Workers `env` binding
 * (apps/web, apps/jobs) or `process.env` in Node contexts (vitest,
 * scripts). Throws if any required var is missing or fails validation —
 * call sites always go through loadConfig(env), never a hardcoded number.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = REQUIRED_VARS.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config env var(s): ${missing.join(", ")}. Copy .env.example to .env for local dev, or set these via Wrangler vars/secrets in deployed environments.`,
    );
  }

  return ConfigSchema.parse({
    concernThresholdT2: env.CONCERN_THRESHOLD_T2,
    quorumPercent: env.QUORUM_PERCENT,
    panelTermMonths: env.PANEL_TERM_MONTHS,
  });
}
