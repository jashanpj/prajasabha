-- Issue #27 (B4 — Constituency Concern threshold & promotion). A column
-- only, no new table: "Constituency Concern" is an orthogonal
-- deliberation-eligibility classification, not a new `issue_status`
-- lifecycle value, so no RLS obligation is triggered (invariant 4 applies
-- to new tables; `issues` is already RLS'd since migration 0000). NULL
-- means not yet promoted; non-NULL is itself the guard against
-- re-triggering the promotion event on subsequent support crossings — see
-- apps/web/src/pages/api/issues/[issueId]/support.ts's atomic
-- compare-and-swap UPDATE.
ALTER TABLE "issues" ADD COLUMN "promoted_at" timestamp with time zone;
