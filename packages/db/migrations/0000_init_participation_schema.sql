-- citext backs members.pseudonym (case-insensitive uniqueness). Created
-- here, not just in docker-compose's init script, because this migration
-- is the only thing that runs against CI's bare postgres:16 service (no
-- init-script mechanism there) — see docker-compose.yml's header comment.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."authority_kind" AS ENUM('councillor', 'ulb', 'mla', 'mp', 'dept', 'agency');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('draft', 'published', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."member_tier" AS ENUM('t0', 't1', 't2');--> statement-breakpoint
CREATE TYPE "public"."routing_role" AS ENUM('responsible', 'copied');--> statement-breakpoint
CREATE TABLE "authorities" (
	"authority_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "authority_kind" NOT NULL,
	"name_ml" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_member_id" uuid,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_support" (
	"issue_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"ward_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_support_issue_member_uniq" UNIQUE("issue_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"issue_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title_ml" text NOT NULL,
	"title_en" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"ward_id" uuid NOT NULL,
	"status" "issue_status" DEFAULT 'draft' NOT NULL,
	"merged_into" uuid,
	"support_t2_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "issues_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"member_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pseudonym" "citext" NOT NULL,
	"tier" "member_tier" DEFAULT 't0' NOT NULL,
	"constituency_id" uuid,
	"ward_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_pseudonym_unique" UNIQUE("pseudonym")
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"rule_cited" text NOT NULL,
	"action" text NOT NULL,
	"public_note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routings" (
	"issue_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"role" "routing_role" NOT NULL,
	"legal_basis_ref" text
);
--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_actor_member_id_members_member_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_support" ADD CONSTRAINT "issue_support_issue_id_issues_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("issue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_support" ADD CONSTRAINT "issue_support_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_members_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routings" ADD CONSTRAINT "routings_issue_id_issues_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("issue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routings" ADD CONSTRAINT "routings_authority_id_authorities_authority_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."authorities"("authority_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_ward_idx" ON "issues" USING btree ("ward_id");--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
-- Row-level security, role grants, and append-only enforcement
-- (CLAUDE.md invariants 3 and 4 — RLS + policy in the same migration as the
-- CREATE TABLE, no exceptions; event_log/moderation_actions get no
-- UPDATE/DELETE grant to any role, ever).
--
-- Roles below are created idempotently because this migration is the only
-- artifact that runs identically against CI's bare postgres:16 service
-- (.github/workflows/ci.yml) and the docker-compose local dev container —
-- docker/postgres/init/ only provisions schemas + LOGIN roles, not these
-- RLS-facing grantee roles (see that file's header comment).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;--> statement-breakpoint
-- Table-level SELECT grant is required before RLS policies below can ever
-- apply — Postgres checks the GRANT first and rejects with "permission
-- denied" before RLS is even evaluated if this is missing. RLS then filters
-- which *rows* of these three tables anon/authenticated actually see.
GRANT SELECT ON "issues", "authorities", "routings" TO anon, authenticated;--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_support" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "authorities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "moderation_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Public read policies (HLD §5: "public tables readable by anon where
-- status='published'"). members/issue_support/event_log/moderation_actions
-- get NO anon/authenticated policy at all in Phase 0 — RLS with zero
-- policies denies all rows by default, which is deliberate default-deny:
-- no Phase-0 feature needs a public member directory, a raw per-vote list
-- (the aggregate issues.support_t2_count covers the public need), or raw
-- log/mod-action reads. Widen with a new migration if a story needs it.
CREATE POLICY "issues_public_read" ON "issues" FOR SELECT TO anon, authenticated USING (status = 'published');--> statement-breakpoint
CREATE POLICY "authorities_public_read" ON "authorities" FOR SELECT TO anon, authenticated USING (true);--> statement-breakpoint
CREATE POLICY "routings_public_read" ON "routings" FOR SELECT TO anon, authenticated USING (issue_id IN (SELECT issue_id FROM issues WHERE status = 'published'));--> statement-breakpoint
-- service_role: full access to the 5 mutable tables. All writes reach these
-- tables only via Astro API endpoints running as service_role after Zod
-- validation (CLAUDE.md invariant 5) — anon/authenticated never get an
-- INSERT/UPDATE/DELETE policy on anything.
CREATE POLICY "service_role_all_members" ON "members" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "service_role_all_issues" ON "issues" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "service_role_all_issue_support" ON "issue_support" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "service_role_all_authorities" ON "authorities" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "service_role_all_routings" ON "routings" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "members", "issues", "issue_support", "authorities", "routings" TO service_role;--> statement-breakpoint
-- Append-only tables (CLAUDE.md invariant 3): service_role may SELECT and
-- INSERT only — never UPDATE or DELETE. Corrections are new rows, never
-- edits to history.
CREATE POLICY "service_role_read_event_log" ON "event_log" FOR SELECT TO service_role USING (true);--> statement-breakpoint
CREATE POLICY "service_role_insert_event_log" ON "event_log" FOR INSERT TO service_role WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "service_role_read_moderation_actions" ON "moderation_actions" FOR SELECT TO service_role USING (true);--> statement-breakpoint
CREATE POLICY "service_role_insert_moderation_actions" ON "moderation_actions" FOR INSERT TO service_role WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT ON "event_log", "moderation_actions" TO service_role;--> statement-breakpoint
-- Belt-and-suspenders: even with no UPDATE/DELETE granted above, revoke
-- explicitly from every relevant role so the immutability guarantee holds
-- regardless of future GRANT mistakes. (Table owner/superuser bypasses
-- this, as with any Postgres privilege — the guarantee is enforced against
-- every role the application ever connects as.)
REVOKE UPDATE, DELETE ON "event_log", "moderation_actions" FROM PUBLIC, anon, authenticated, service_role;