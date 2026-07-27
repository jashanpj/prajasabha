CREATE TYPE "vault"."vault_access_caller" AS ENUM('internal', 'review');--> statement-breakpoint
CREATE TYPE "vault"."vault_access_operation" AS ENUM('registration.start.duplicate_check', 'registration.consume', 'registration.complete.lookup', 'epic.link.lookup', 'epic.status', 'epic.review_queue');--> statement-breakpoint
CREATE TYPE "vault"."vault_access_outcome" AS ENUM('ok', 'not_found', 'denied');--> statement-breakpoint
CREATE TABLE "vault"."access_log" (
	"access_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" "vault"."vault_access_operation" NOT NULL,
	"subject_ref" uuid,
	"caller" "vault"."vault_access_caller" NOT NULL,
	"outcome" "vault"."vault_access_outcome" NOT NULL,
	"row_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_log_at_idx" ON "vault"."access_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "access_log_subject_ref_idx" ON "vault"."access_log" USING btree ("subject_ref");--> statement-breakpoint
-- Row-level security + role grants (CLAUDE.md invariant 4 — RLS + policy in
-- the same migration as the CREATE TABLE, no exceptions).
ALTER TABLE "vault"."access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- APPEND-ONLY (CLAUDE.md invariant 3), and the only append-only table in the
-- vault. Unlike auth_credentials and epic_verifications — which get a single
-- FOR ALL policy plus an UPDATE grant — this follows packages/db's event_log
-- shape: split SELECT/INSERT policies and no UPDATE or DELETE grant.
-- vault_role is the role that performs the identity reads this table audits,
-- so if it could also rewrite the table there would be no audit trail.
CREATE POLICY "vault_role_read_access_log" ON "vault"."access_log" FOR SELECT TO vault_role USING (true);--> statement-breakpoint
CREATE POLICY "vault_role_insert_access_log" ON "vault"."access_log" FOR INSERT TO vault_role WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT ON "vault"."access_log" TO vault_role;--> statement-breakpoint
-- Belt-and-suspenders, mirroring packages/db migration 0000's REVOKE on
-- event_log/moderation_actions: even though no UPDATE/DELETE is granted above,
-- revoke explicitly so the immutability guarantee survives a future GRANT
-- mistake — including a blanket `GRANT ALL ON ALL TABLES IN SCHEMA vault`,
-- which is why TRUNCATE is revoked too (it is a separate privilege from
-- DELETE, is not covered by RLS, and would wipe the audit trail).
--
-- vault_role and PUBLIC are always present: vault_role is created idempotently
-- by this package's migration 0000, PUBLIC is a pseudo-role.
REVOKE UPDATE, DELETE, TRUNCATE ON "vault"."access_log" FROM PUBLIC, vault_role;--> statement-breakpoint
-- anon/authenticated/service_role are packages/db's roles, created by ITS
-- migration 0000. They hold no grant on schema vault, so there is nothing to
-- revoke in principle — but naming them directly would make this migration
-- fail outright in a standalone vault database (HLD §4.1's real deployment
-- shape, and `pnpm --filter vault-db test` run on its own), because
-- `REVOKE ... FROM <nonexistent role>` is a hard ERROR that rolls back the
-- whole file, leaving no table, no RLS and no append-only protection.
--
-- So revoke them only where they exist, using the same conditional-on-pg_roles
-- idiom migration 0000 uses to create vault_role. That keeps parity with
-- packages/db's own REVOKE (which does name them) without coupling this
-- package's migrations to another package's roles.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE ON "vault"."access_log" FROM %I', target
      );
    END IF;
  END LOOP;
END $$;
