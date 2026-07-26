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
}
