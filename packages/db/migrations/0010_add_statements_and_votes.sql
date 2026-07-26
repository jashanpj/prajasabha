CREATE TYPE "public"."statement_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."statement_vote" AS ENUM('agree', 'disagree', 'pass');--> statement-breakpoint
CREATE TABLE "statement_votes" (
	"statement_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"vote" "statement_vote" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_votes_statement_member_uniq" UNIQUE("statement_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"statement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deliberation_id" uuid NOT NULL,
	"author_member_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" "statement_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "statement_votes" ADD CONSTRAINT "statement_votes_statement_id_statements_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("statement_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_votes" ADD CONSTRAINT "statement_votes_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_deliberation_id_deliberations_deliberation_id_fk" FOREIGN KEY ("deliberation_id") REFERENCES "public"."deliberations"("deliberation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_author_member_id_members_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statements_deliberation_id_status_idx" ON "statements" USING btree ("deliberation_id","status");--> statement-breakpoint
-- Row-level security (CLAUDE.md invariants 3 and 4). `statements` is
-- public-readable but gated on TWO conditions, not one: status='approved'
-- (the moderation-queue gate, same status-filter shape as
-- `issues_public_read` in migration 0000) AND the parent deliberation's
-- issue still being 'published' (same join-gate shape as migration 0009's
-- `deliberations_public_read`, fixed there after a schema-guard review
-- caught the unconditional-`true` version — applying that lesson here from
-- the start: an issue merged/closed after its deliberation opened must
-- take its statements dark too, not just its deliberation status line).
GRANT SELECT ON "statements" TO anon, authenticated;--> statement-breakpoint
ALTER TABLE "statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "statements_public_read" ON "statements" FOR SELECT TO anon, authenticated USING (
  status = 'approved'
  AND deliberation_id IN (
    SELECT deliberation_id FROM deliberations
    WHERE issue_id IN (SELECT issue_id FROM issues WHERE status = 'published')
  )
);--> statement-breakpoint
CREATE POLICY "service_role_all_statements" ON "statements" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "statements" TO service_role;--> statement-breakpoint
-- `statement_votes`: internal only, same treatment as `routing_rules`
-- (migration 0005) — a per-vote row is finer-grained civic-activity data
-- than any AC needs public; only server-computed aggregates (the
-- consensus surface, issue #34) are ever exposed. NO anon/authenticated
-- SELECT policy at all — zero policies for those roles is default-deny.
ALTER TABLE "statement_votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "service_role_all_statement_votes" ON "statement_votes" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "statement_votes" TO service_role;