CREATE TYPE "public"."deliberation_state" AS ENUM('open', 'extended', 'closed', 'summarized');--> statement-breakpoint
CREATE TABLE "deliberations" (
	"deliberation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"state" "deliberation_state" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"extended_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"summarized_at" timestamp with time zone,
	"summary_artifact_key" text,
	CONSTRAINT "deliberations_issue_id_uniq" UNIQUE("issue_id")
);
--> statement-breakpoint
ALTER TABLE "deliberations" ADD CONSTRAINT "deliberations_issue_id_issues_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("issue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliberations_state_closes_at_idx" ON "deliberations" USING btree ("state","closes_at");--> statement-breakpoint
-- Row-level security (CLAUDE.md invariants 3 and 4 — RLS + policy in the
-- same migration as the CREATE TABLE). `deliberations` is a child of
-- `issues`, and `issues.status` is mutable after publish (published ->
-- merged | closed) — a promoted issue can still later be merged or
-- administratively closed, at which point its sibling `routings` rows go
-- dark too (migration 0000's `routings_public_read` gates on
-- `status = 'published'` for exactly this reason). So this is the
-- `routings` pattern, not `authorities`' unconditional `USING (true)` —
-- `authorities` is genuinely static reference data with no parent status
-- to track, `deliberations` isn't.
GRANT SELECT ON "deliberations" TO anon, authenticated;--> statement-breakpoint
ALTER TABLE "deliberations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "deliberations_public_read" ON "deliberations" FOR SELECT TO anon, authenticated USING (issue_id IN (SELECT issue_id FROM issues WHERE status = 'published'));--> statement-breakpoint
CREATE POLICY "service_role_all_deliberations" ON "deliberations" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deliberations" TO service_role;