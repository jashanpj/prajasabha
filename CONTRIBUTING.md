# Contributing to PrajaSabha

Thanks for contributing to a civic transparency platform. Before anything
else, read `CLAUDE.md` at the repo root — its invariants are not style
preferences, they're the reason the identity/participation separation in
this system is trustworthy. If you use Claude Code (or another AI coding
tool) locally, it will read the same file and enforce the same rules for
you via the checked-in `.claude/agents` and `.claude/hooks`.

## Getting started

```bash
git clone https://github.com/jashanpj/prajasabha.git
cd prajasabha
pnpm install
cp .env.example .env
docker compose up -d                # local Postgres: `public` (participation) + `vault` schema
pnpm --filter db run migrate        # applies packages/db's migrations
pnpm --filter vault-db run migrate  # applies packages/vault-db's migrations
pnpm dev
```

You don't need a Supabase or Cloudflare account to get a local dev loop
running — those are only required for deploying, not for building.

Registration (issue #20) is served across two Workers: `apps/web` (the
form + API endpoints) and `apps/vault-svc` (the only thing that talks to
the identity vault, reached via a Cloudflare service binding, never a
direct import). `pnpm dev` runs both — but a real `wrangler dev` service
binding between two separately-running dev servers needs each Worker's
`wrangler dev` pointed at the other via `--host`/config, which isn't fully
wired up yet for local multi-worker dev; `pnpm --filter web test` /
`pnpm --filter vault-svc test` exercise the full logic against a real
Postgres without needing that (each test mocks the other side's HTTP
boundary — see `apps/web/src/pages/api/auth/register/*.test.ts` and
`apps/vault-svc/src/index.test.ts`).

`docker-compose.yml` runs a single Postgres container with two schemas,
`public` and `vault`, isolated from each other by role grants (see the
file's header comment and `docker/postgres/init/`). This is a local-dev
convenience, not the production security boundary — prod keeps the
participation DB and identity vault in two physically separate Supabase
projects (HLD §4.1). Don't point staging/prod config at this compose file.

## Workflow

- One issue → one branch (`<type>/<issue-number>-slug`) → one PR.
  Reference `Closes #<issue>` in the PR description.
- Copy Acceptance Criteria from the issue into the PR template and check
  them off as you satisfy them.
- Every user-facing string change touches both `src/i18n/ml.json` and
  `src/i18n/en.json` in the same commit — Malayalam is the default locale.
- Conventional Commits: `feat|fix|chore|docs(<module scope>): <summary>`,
  e.g. `feat(delib): statement voting endpoint`.
- Tests are colocated (Vitest). Every new endpoint needs an authz test;
  every new append-only table needs an immutability test.

## Sign your commits (DCO)

We use a Developer Certificate of Origin instead of a CLA. Sign every
commit:

```bash
git commit -s -m "feat(delib): statement voting endpoint"
```

This adds a `Signed-off-by` trailer certifying you have the right to submit
the contribution under this project's license. PRs with unsigned commits
will fail the DCO check.

## Good first issues

Look for the `good-first-issue` label. Issues use structured templates
(Story/Acceptance Criteria/Module/Out of scope/Test notes) specifically so
they're actionable without needing a design discussion first.

## Security

Do not open a public issue for a security vulnerability — see
`SECURITY.md` for private reporting.
