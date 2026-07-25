import { z } from "zod";

// PRD/HLD-adopted values (see .env.example for the full var list this
// mirrors): Concern threshold = 100 T2 supporters (PRD Module B4 AC),
// quorum = 20% of verified constituents (PRD), panel term = 6 months (HLD
// §8 / design v1.1 — PRD v1.0's 90 days is superseded, though PRD §8 still
// lists it under "Open Product Decisions", so treat 6 months as the
// current adopted value, not yet fully locked).
//
// These are the loader's OWN documented fallback for local dev/tests, not
// magic numbers at business-logic call sites — CLAUDE.md invariant 6
// ("no secrets, thresholds, or rate-limit values in code — Wrangler
// secrets / KV config only") governs production values, which come from
// env (itself populated by Wrangler vars/secrets or a KV-backed config
// loader upstream of this function). Call sites always go through
// loadConfig(env), never compare against a hardcoded number directly.
const LOCAL_DEV_DEFAULTS = {
  CONCERN_THRESHOLD_T2: "100",
  QUORUM_PERCENT: "20",
  PANEL_TERM_MONTHS: "6",
} satisfies Record<string, string>;

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
 * scripts). Unset vars fall back to LOCAL_DEV_DEFAULTS; set vars always
 * win, and an invalid value throws a ZodError rather than silently
 * coercing to something wrong.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const source = { ...LOCAL_DEV_DEFAULTS, ...stripUndefined(env) };
  return ConfigSchema.parse({
    concernThresholdT2: source.CONCERN_THRESHOLD_T2,
    quorumPercent: source.QUORUM_PERCENT,
    panelTermMonths: source.PANEL_TERM_MONTHS,
  });
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
