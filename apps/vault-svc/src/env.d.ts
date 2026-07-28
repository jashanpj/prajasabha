/// <reference types="@cloudflare/workers-types" />

export interface Bindings {
  // vault_role-scoped connection (not the superuser VAULT_DATABASE_URL
  // used for migrations) — see packages/vault-db/migrations/0000's role
  // comment and .env.example.
  VAULT_SVC_DATABASE_URL: string;
  EMAIL_ENCRYPTION_KEY: string;
  EMAIL_HASH_PEPPER: string;
  VAULT_SVC_INTERNAL_TOKEN: string;
  MAGIC_LINK_TTL_MINUTES: string;
  // Issue #16/#22 — A3 EPIC verification. Three secrets distinct from the
  // email ones above and from each other (see crypto.ts's header comment).
  EPIC_HASH_PEPPER: string;
  EPIC_ENCRYPTION_KEY: string;
  EPIC_DOC_ENCRYPTION_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  REVIEW_QUEUE_TOKEN: string;
  REVIEW_QUEUE_IP_ALLOWLIST: string;
  // /public/epic/submit rate limiting (issue #22 — Turnstile alone isn't
  // sufficient volumetric protection for a public mutation endpoint, same
  // posture as apps/web's register/start.ts).
  RATE_LIMIT_KV: KVNamespace;
  EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: string;
  // Issue #23 (A4) — rows exposed by a single vault call above which
  // logVaultAccess also emits a structured warn line for alerting. A
  // threshold, so config not a literal (CLAUDE.md invariant 6).
  VAULT_ACCESS_ALERT_ROW_THRESHOLD: string;
}
