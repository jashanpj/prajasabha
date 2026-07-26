-- Issue #90 (constituency dashboard). security-reviewer flagged two
-- queries on dashboard.astro that run on every anonymous page load with
-- no supporting index: the "top issues" list (status='published' ORDER
-- BY support_t2_count DESC) and the per-issue responsible-authority
-- lookup (routings.issue_id has no index — a FK doesn't create one
-- implicitly in Postgres). Index only, no new table: no RLS obligation
-- (invariant 4 applies to new tables; both tables are already RLS'd).
CREATE INDEX "issues_status_support_idx" ON "issues" USING btree ("status","support_t2_count");--> statement-breakpoint
CREATE INDEX "routings_issue_id_idx" ON "routings" USING btree ("issue_id");