-- Issue #89 (home page redesign) added a "N verified constituents" stat
-- that runs `count(*) FROM members WHERE tier = 't2'` on every homepage
-- load, including anonymous visitors — security-reviewer flagged this as
-- an unindexed full-table scan on the app's highest-traffic page. Index
-- only, no new table: no RLS obligation is triggered (invariant 4 applies
-- to new tables; `members` is already RLS'd since migration 0000).
CREATE INDEX "members_tier_idx" ON "members" USING btree ("tier");