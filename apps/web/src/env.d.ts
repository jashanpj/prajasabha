/// <reference types="astro/client" />

// Astro v6 + @astrojs/cloudflare no longer expose bindings via
// `Astro.locals.runtime.env` (removed — see that package's own runtime
// deprecation error). Bindings now come from
// `import { env } from "cloudflare:workers"`, typed via this
// declaration-merged `Cloudflare.Env` interface (the same mechanism
// `wrangler types` would generate into). Because that import is a
// virtual module only resolvable inside a real Workers/Miniflare
// runtime, every route handler here is a thin wrapper that does the
// import lazily inside its function body — see
// src/pages/api/auth/register/{start,verify}.ts — so Vitest can import
// and test the underlying pure functions without ever resolving
// "cloudflare:workers".
declare namespace Cloudflare {
  interface Env {
    // packages/db runtime connection — app_role, inherits service_role's
    // grants via role membership (packages/db/migrations/0002). See
    // apps/web/src/lib/db.ts.
    APP_DATABASE_URL: string;
    // Cloudflare KV — fixed-window rate-limit counters (packages/shared's
    // checkAndIncrement).
    RATE_LIMIT_KV: KVNamespace;
    // Service binding to apps/vault-svc — the only way apps/web reaches
    // the identity vault, never a direct packages/vault-db import
    // (invariant 2).
    VAULT_SVC: Fetcher;
    VAULT_SVC_INTERNAL_TOKEN: string;
    RESEND_API_KEY: string;
    TURNSTILE_SECRET_KEY: string;
    TURNSTILE_SITE_KEY: string;
    SESSION_SECRET: string;
    // Read here only for the emailed copy ("expires in N minutes") — the
    // enforced expiry itself lives in apps/vault-svc, which computes
    // expiresAt from this same var.
    MAGIC_LINK_TTL_MINUTES: string;
    REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: string;
    REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: string;
    VERIFY_RATE_LIMIT_PER_IP_PER_HOUR: string;
    // Issue #22 — A3 EPIC verification. loadEpicVerificationConfig's vars
    // (verify/epic/status.ts) plus the public URL verify/epic.astro's
    // client-side JS posts the raw EPIC number/doc to directly (HLD §4.3's
    // "separate origin" — never proxied through this app).
    PILOT_CONSTITUENCY_NAME_ML: string;
    PILOT_CONSTITUENCY_NAME_EN: string;
    COVERED_ASSEMBLY_SEGMENTS: string;
    PUBLIC_VAULT_SVC_URL: string;
    // Rate limit on /api/verify/epic/submit — the one call that can reveal
    // "already verified by someone else" (409 duplicate_epic), so it's
    // rate-limited per-member, not just Turnstile-gated upstream.
    EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: string;
    // Issue #24 — B1 Raise an Issue. R2 bucket for EXIF-stripped evidence
    // photos (keys recorded in issues.photo_keys), plus the config-driven
    // category/ward allow-lists (loadIssueCategoriesConfig /
    // loadPilotWardsConfig) that publish-time validation and the form's
    // <select>s read.
    ISSUE_PHOTOS: R2Bucket;
    ISSUE_CATEGORIES: string;
    PILOT_WARD_IDS: string;
    PILOT_WARD_NAMES_ML: string;
    PILOT_WARD_NAMES_EN: string;
    // Per-member hourly limits for create/draft/photos/publish
    // (loadIssueRateLimitConfig) — session-authed, so no Turnstile, but
    // still rate-limited like every other mutation endpoint here.
    ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR: string;
    ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR: string;
    ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR: string;
    ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR: string;
  }
}
