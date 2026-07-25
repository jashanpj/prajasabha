## What & why

Closes #

## Acceptance criteria

<!-- Copy the ACs from the issue and check them off. -->
- [ ]

## CLAUDE.md invariants checklist

- [ ] No table/type/log line/analytics event/fixture joins an identity
      attribute with a civic-activity attribute (vault join rule)
- [ ] `packages/vault-db` is not imported from `apps/web`, `apps/api`, or `apps/jobs`
- [ ] No UPDATE/DELETE added to any append-only table
- [ ] Any new table ships with its RLS policy in the same migration
- [ ] All writes go through Astro API endpoints, not direct client→Supabase mutations
- [ ] No secrets/thresholds/rate-limit values committed in code
- [ ] Status strings (if any) come from `packages/shared/status.ts` verbatim
- [ ] No composite scores, stars, rankings, or aggregate approval numbers introduced
- [ ] Sentiment displays (if any) render the sample-size caveat component
- [ ] New sentiment-rendering paths are gated by the election-mode flag

## i18n

- [ ] Every user-facing string added is present in both `src/i18n/ml.json` and `src/i18n/en.json` in this commit
- [ ] N/A — no user-facing strings changed

## Test notes

<!-- What did you run, and how would a reviewer re-verify it? -->
