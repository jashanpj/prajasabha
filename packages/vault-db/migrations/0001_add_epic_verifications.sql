CREATE TYPE "vault"."epic_verification_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "vault"."epic_verifications" (
	"verification_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid,
	"epic_number_hash" text NOT NULL,
	"epic_number_ciphertext" text,
	"epic_number_iv" text,
	"doc_ciphertext" text,
	"doc_iv" text,
	"assembly_segment_claimed" text NOT NULL,
	"status" "vault"."epic_verification_status" DEFAULT 'pending' NOT NULL,
	"reviewer_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "epic_verifications_hash_idx" ON "vault"."epic_verifications" USING btree ("epic_number_hash");--> statement-breakpoint
CREATE INDEX "epic_verifications_member_id_idx" ON "vault"."epic_verifications" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epic_verifications_hash_approved_uniq" ON "vault"."epic_verifications" USING btree ("epic_number_hash") WHERE "vault"."epic_verifications"."status" = 'approved';--> statement-breakpoint
-- Row-level security + role grant (CLAUDE.md invariant 4 — RLS + policy in
-- the same migration as the CREATE TABLE, no exceptions). Same posture as
-- migration 0000's auth_credentials policy: only apps/vault-svc ever
-- connects as vault_role, already gated by its own bearer-token/
-- IP-allowlist checks on every route — no anon/authenticated/service_role
-- grant on this schema at all.
ALTER TABLE "vault"."epic_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "vault_role_all_epic_verifications" ON "vault"."epic_verifications" FOR ALL TO vault_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "vault"."epic_verifications" TO vault_role;