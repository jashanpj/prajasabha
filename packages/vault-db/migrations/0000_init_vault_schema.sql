-- vault_role, referenced by the GRANT/POLICY below, is expected to exist
-- as a LOGIN role in local dev (created by docker-compose's
-- docker/postgres/init/01-schemas-and-roles.sql, password
-- 'vault_role_dev_only' — dev-only, documented, not a real secret, same
-- posture as that file's other passwords). CI's bare postgres:16 service
-- has no init-script mechanism at all, so this migration also creates it
-- idempotently — since this file is the only artifact that runs
-- identically in both places. LOGIN + a password (not NOLOGIN): unlike
-- packages/db's anon/authenticated/service_role, apps/vault-svc connects
-- directly AS vault_role at runtime (issue #20) rather than switching into
-- it via SET ROLE from a superuser session, so it genuinely needs to log
-- in — see VAULT_SVC_DATABASE_URL in .env.example.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_role') THEN
    CREATE ROLE vault_role LOGIN PASSWORD 'vault_role_dev_only';
  END IF;
END
$$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "vault";
--> statement-breakpoint
CREATE TABLE "vault"."auth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"email_ciphertext" text NOT NULL,
	"email_iv" text NOT NULL,
	"pseudonym" text NOT NULL,
	"locale" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"linked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_credentials_email_hash_idx" ON "vault"."auth_credentials" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "auth_credentials_token_hash_idx" ON "vault"."auth_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_credentials_email_hash_linked_uniq" ON "vault"."auth_credentials" USING btree ("email_hash") WHERE "vault"."auth_credentials"."linked" = true;--> statement-breakpoint
-- Row-level security + role grant (CLAUDE.md invariant 4 — RLS + policy in
-- the same migration as the CREATE TABLE, no exceptions).
ALTER TABLE "vault"."auth_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT USAGE ON SCHEMA "vault" TO vault_role;--> statement-breakpoint
-- Single FOR ALL policy: only apps/vault-svc ever connects as vault_role,
-- already gated by its own bearer-token check on every internal route —
-- no anon/authenticated/service_role grant on this schema at all (those
-- Postgres roles have no business touching vault.* per the vault join
-- rule's isolation posture).
CREATE POLICY "vault_role_all_auth_credentials" ON "vault"."auth_credentials" FOR ALL TO vault_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "vault"."auth_credentials" TO vault_role;
