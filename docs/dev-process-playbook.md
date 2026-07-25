# Development Process Playbook
## Praja — Claude Code-Driven, Open-Source Delivery Pipeline

**Version:** 1.0 | **Date:** July 2026
**Parent docs:** PRD v1.1 · HLD v1.0 · Security Design v1.0 · STACK.md
**Principle:** One senior engineer + Claude Code + free open-source infrastructure = a full team's throughput. Every rupee spent must buy tokens or SMS, not tooling.

---

## 0. The decision that shapes everything: GitHub Issues, not Jira

Use **GitHub Issues + GitHub Projects** as the single task system. Not Jira.

| Factor | GitHub Issues/Projects | Jira |
|---|---|---|
| Cost | ₹0 (public repo) | Free tier limited; friction anyway |
| Where contributors already are | Yes — issue → PR → review in one place | No; OSS contributors won't sign up |
| Claude Code integration | Native: `gh` CLI in-terminal + official claude-code-action (@claude on issues/PRs) | Via Atlassian MCP — works, but an extra moving part |
| Transparency mission | Public roadmap = product value for a transparency platform | Private by default |
| CI/CD linkage | Same platform as Actions | Webhook glue |

Jira adds cost and friction and removes your contributors' ability to see the roadmap. For this project the public issue tracker *is part of the product's credibility*. (If a future funder mandates Jira, bridge it with the Atlassian MCP server in `.mcp.json` — don't restructure.)

**Structure:**
- **Milestones** = PRD milestones M0–M7.
- **Labels:** `module:A`…`module:L` (PRD modules), `type:story|bug|chore|spike`, `good-first-issue`, `security` (private advisory instead when sensitive), `needs-design`.
- **GitHub Projects board:** Backlog → Ready → In Progress → In Review → Staging → Done. Automation rules move cards on PR events — zero manual updates.
- **Issue templates** (`.github/ISSUE_TEMPLATE/story.yml`): Story / Acceptance criteria (copied from PRD ACs) / Module / Out of scope / Test notes. Claude Code reads these fields directly — well-structured issues are literally prompts.

**Seeding the backlog:** one-time job — point Claude Code at `pilot-mvp-prd-v1.1.md` and have it decompose Modules A–L into issues with ACs, labels, and milestones via `gh issue create`. Review the batch before it posts (`--dry-run` to a markdown file first). Your PRD becomes ~80–120 ready stories in an afternoon.

---

## 1. Repository governance for AI-assisted development

### 1.1 `CLAUDE.md` (repo root — Claude Code's persistent project memory)

The rules file every session loads. Keep it under ~150 lines; link out to docs for detail. Praja's must encode the **non-negotiables**:

```markdown
# CLAUDE.md — Praja

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
```

### 1.2 Subagents (`.claude/agents/`)

Focused reviewers Claude Code delegates to — each with its own context and constrained tools. Praja ships four:

| Agent | Trigger | What it does |
|---|---|---|
| `security-reviewer.md` | Before any PR; on demand | Checks the six invariants, secret leakage, authz on new endpoints, Turnstile/rate-limit presence on mutations. Read-only tools. |
| `schema-guard.md` | Any change under `packages/db|vault-db` | Enforces the vault join rule on migrations, RLS-with-table rule, append-only grants; blocks cross-package imports. |
| `i18n-auditor.md` | UI changes | Diffs ml.json vs en.json keys, flags hardcoded strings, checks status strings come from shared/status.ts. |
| `test-writer.md` | New endpoints/jobs | Writes the authz + happy-path + rate-limit tests from the issue's ACs before implementation (TDD). |

Example (`.claude/agents/schema-guard.md`):
```markdown
---
name: schema-guard
description: Reviews any database schema or migration change for Praja's
  identity-separation invariants. Use proactively on changes to packages/db,
  packages/vault-db, or any *.sql file.
tools: Read, Grep, Glob
---
You review schema changes for a civic platform where identity/participation
separation is existential. Reject with specific line references if:
- any participation-DB table/column stores identity attributes (names, phone,
  Aadhaar, EPIC, addresses) or vice versa
- a migration creates a table without RLS enabled + at least one policy
- append-only tables gain UPDATE/DELETE grants or ON UPDATE triggers
- packages/vault-db is imported outside vault-svc
- a migration edits history instead of adding a new file
Output: PASS or FAIL + numbered findings + suggested fix per finding.
```

### 1.3 Hooks (`.claude/settings.json`) — deterministic guardrails

Hooks fire on lifecycle events and can block actions before they happen — enforcement, not suggestion:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { // Block edits to committed migrations & vault package from general sessions
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
          "command": ".claude/hooks/protect-paths.sh" }] // exits 2 on packages/db/migrations/*​ (existing files), packages/vault-db unless PRAJA_VAULT_WORK=1
      },
      { // Secret & Aadhaar-pattern scan on anything about to be written
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
          "command": ".claude/hooks/secret-scan.sh" }] // gitleaks protect + regex for 12-digit Aadhaar-like literals in fixtures
      }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
          "command": "pnpm biome check --write --no-errors-on-unmatched $CLAUDE_FILE_PATHS" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command",
          "command": ".claude/hooks/verify-i18n.sh" }] } // ml/en key parity before Claude declares done
    ]
  }
}
```

### 1.4 Slash commands (`.claude/commands/`)

- `/story <issue#>` → runs `gh issue view <n> --json title,body,labels`, enters plan mode, proposes plan + test list, waits for approval.
- `/ship` → run tests → conventional commit → push → `gh pr create` with template (ACs checklist, invariants checklist, i18n confirmation) → moves Project card.
- `/triage` → reads new unlabeled issues, proposes labels/milestone/duplicates for your approval.

---

## 2. The daily loop (what you actually do)

```
pick issue (Ready column)
  └─ claude → /story 142
       └─ plan mode: implementation plan + tests derived from ACs   [you approve]
       └─ test-writer agent writes failing tests
       └─ implement; hooks auto-format, block violations
       └─ security-reviewer + schema-guard + i18n-auditor pass
       └─ /ship → PR opens, card moves to In Review
CI takes over (Actions, §3)
  └─ you review the diff (YOU are the reviewer of record — AI never self-merges)
  └─ merge → preview/staging deploy → card to Staging → prod tag → Done
```

Issue updates are automatic: `Closes #142` + Projects automation. You never move a card or update a status by hand.

**Rules of engagement (senior-engineer discipline):**
- Plan mode is mandatory for multi-file changes; you approve plans, not vibes.
- One issue = one branch = one PR = one Claude session where possible (clean context beats /compact archaeology).
- You read every diff before merge. The subagents reduce review load; they don't replace the human accountable to the constitution-level invariants.
- `--dangerously-skip-permissions` never on this repo; the vault join rule is exactly the kind of thing autonomy erodes.

---

## 3. CI/CD (all free on a public repo)

GitHub Actions minutes are **free for public repositories** — this is the single biggest open-source leverage. The pipeline:

**On PR (`ci.yml`):**
1. `pnpm install --frozen-lockfile`
2. Biome check + `tsc --noEmit` (strict)
3. Vitest (unit + endpoint authz tests) against docker-compose Postgres (with RLS enabled — authz tests are real)
4. Drizzle migration dry-run against fresh DB (catches ordering breaks for forks)
5. i18n parity check script
6. Playwright smoke (verify flow mock, issue page, ledger render) — chromium only, keep <5 min
7. Bundle-size budget check: fail if any route's JS > 50KB (STACK.md target enforced by CI, not intention)

**Security lane (free for public repos):**
- **CodeQL** weekly + on PR (JS/TS)
- **Dependabot** (deps + Actions versions) with `pnpm audit` gate
- **gitleaks** full-history scan on push
- OpenSSF Scorecard action (badge = trust signal for a transparency platform)

**Claude in CI (`claude.yml` — the official claude-code-action):**
- Trigger: **@claude mentions only**, and only from users with `OWNER|MEMBER|COLLABORATOR` association. Never auto-run on every PR, and never on fork-PR events with secrets access — untrusted issue/PR bodies are prompt-injection surface and API-cost surface.
- Uses: "@claude review this PR against CLAUDE.md invariants", "@claude implement #142", "@claude fix the failing i18n check".
- `ANTHROPIC_API_KEY` in repo secrets; concurrency group per-PR so runs cancel stale ones; `max_turns` capped.
- Setup: `claude` → `/install-github-app` from the terminal.

**Deployment (Cloudflare Workers Builds — GitHub-connected, per STACK.md):**
- PR → **preview URL** per branch (web Worker) — reviewers and designers click, not clone
- `main` → **staging** environment (separate Supabase staging project)
- Tag `v*` → **production**; migrations applied by a gated Actions job (manual approval environment) *before* the Worker deploy; `vault-svc` deploys are always manual-approval
- Rollback = redeploy previous tag (Workers versioning) + migrations are forward-only with compensating scripts

---

## 4. Open-source leverage (beyond free minutes)

| Lever | What it buys |
|---|---|
| Public repo | Free Actions, CodeQL, Dependabot, unlimited collaborators, Pages for docs |
| `CONTRIBUTING.md` + `docker-compose up` onboarding (STACK.md §11) | Contributors productive without Supabase/CF accounts |
| `good-first-issue` + issue templates with ACs | Claude-readable issues are also human-contributor-readable — same investment, double return |
| **Contributors using their own Claude Code on your CLAUDE.md** | Your rules file scales your standards to people you've never met — subagents and hooks ship with the repo, so every contributor's AI enforces the vault rule too |
| PR template checklist mirroring the invariants | Review load stays sane as PRs arrive |
| `SECURITY.md` + private vulnerability reporting + security.txt | Responsible-disclosure channel (Security Design §6 expects researchers) |
| DCO sign-off (not CLA) | Low-friction IP hygiene for an eventual Section 8 entity |
| Project Galileo, Supabase/Sentry OSS tiers | Infra subsidies already in STACK.md — the public repo is the eligibility proof |
| Public roadmap (Projects board) | For *this* product, open process is marketing |

---

## 5. Cost model (monthly, steady-state pilot build)

| Item | Cost |
|---|---|
| Claude **Max 5x** subscription — includes Claude Code for interactive dev (your daily driver; Pro at ~$20 works but you'll hit limits on heavy days; Max 20x only if you're running parallel sessions routinely) | ~$100 (~₹8,700) |
| claude-code-action API usage (mention-only discipline, ~30–60 invocations/mo) | ~$10–30 (~₹900–2,600) |
| GitHub (public repo: Actions, CodeQL, Dependabot, Projects) | ₹0 |
| Cloudflare Workers Paid (per HLD A9) | $5 (~₹450) |
| Supabase (free tier through build; Pro at launch) | ₹0 → ~₹2,100 |
| Sentry OSS / CF Analytics / gitleaks / Biome / Playwright | ₹0 |
| **Total during build** | **~₹10–12k/mo** |

The discipline that keeps this flat: subscription for interactive work (predictable), API only for CI mentions (metered, capped by association-gating and `max_turns`). If CI costs creep, the fix is fewer auto-triggers, not a bigger budget.

Current pricing/limits: https://docs.claude.com/en/docs/claude-code/overview and https://www.anthropic.com/pricing — verify before committing, plans change.

---

## 6. Setup checklist (one afternoon)

1. `gh repo create praja --public` → push monorepo skeleton (STACK.md §11) + docker-compose
2. Commit `CLAUDE.md`, `.claude/agents/*`, `.claude/settings.json` hooks, `.claude/commands/*`, `.mcp.json` (empty for now)
3. `.github/`: ISSUE_TEMPLATE (story/bug/spike), PR template, `ci.yml`, `codeql.yml`, `dependabot.yml`, SECURITY.md, CONTRIBUTING.md, DCO
4. `claude` → `/install-github-app` → add `ANTHROPIC_API_KEY` secret → restrict `claude.yml` triggers to maintainer association
5. Projects board + automation rules; milestones M0–M7; labels
6. Backlog seeding session: PRD v1.1 → issues (dry-run review → post)
7. Connect Workers Builds (preview/staging/prod) + protected `main` (CI required, 1 review — you)
8. First real test: `/story` the smallest M0 spike end-to-end and tune hooks/agents from what annoys you

---
*End v1.0. Revisit after M1: promote whatever the security-reviewer keeps catching into a PreToolUse hook (agents advise; hooks enforce), and prune any CLAUDE.md rule that hasn't prevented a real mistake.*
