# CLAUDE.md — PrajaSabha

## Architecture invariants (violating these fails review, no exceptions)
1. VAULT JOIN RULE: No table, type, log line, analytics event, or test fixture
   may contain both an identity attribute (name, phone, Aadhaar/EPIC anything)
   and a civic-activity attribute (vote, statement, support, issue). Identity
   lives in packages/vault-db only. packages/db knows only member_id + pseudonym
   + tier + constituency/ward.
2. packages/vault-db is NEVER imported by apps/web, apps/api, or apps/jobs.
3. Append-only tables (event_log, tx_status_events, sortition_draws,
   moderation_actions): no UPDATE/DELETE anywhere — corrections are new
   compensating events.
4. Every new table ships WITH its RLS policy in the same migration. No exceptions,
   including lookup tables.
5. All writes go through Astro API endpoints (rate-limited, audited). Never
   direct client→Supabase mutations.
6. No secrets, thresholds, or rate-limit values in code. Wrangler secrets /
   KV config only. Assume hostile readers of this public repo.

## Product law (copy exactly, never paraphrase)
- Status strings: "Delivered", "→ Acknowledged", "✓ Acted upon",
  "– No response — N days" — from packages/shared/status.ts only.
- NO composite scores, stars, rankings, or aggregate approval numbers. Ever.
- Every sentiment display must render its sample-size caveat component.
- Election-mode flag (KV) must gate any new sentiment-rendering path.

## Code standards
- TypeScript strict; Zod at every boundary; Biome (don't hand-format).
- Astro islands: no client directive by default; justify any client:load in
  the PR description.
- i18n: every user-facing string added to BOTH src/i18n/ml.json and en.json
  in the same commit. Malayalam is the default locale.
- Tests: Vitest colocated; every endpoint gets an authz test (RLS + role);
  every append-only table gets an immutability test.
- Conventional Commits (feat/fix/chore/docs + module scope, e.g.
  `feat(delib): statement voting endpoint`).

## Workflow
- Branch per issue: `<type>/<issue-number>-slug`. Reference "Closes #N" in PR.
- Plan mode before any multi-file change. TDD for endpoints and jobs.
- Never run drizzle-kit push against remote DBs; migrations only, applied by CI.