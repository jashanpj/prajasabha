# Deploying PrajaSabha

Three environments, one per Wrangler environment, per HLD §8: `dev`,
`staging`, `prod`. **No secret value is shared between them.**

## Which environment does a deploy target?

| Command | Worker deployed | Notes |
|---|---|---|
| `pnpm --filter <app> deploy:dev` | `prajasabha-<app>-dev` | Also what a bare `wrangler deploy` hits |
| `pnpm --filter <app> deploy:staging` | `prajasabha-<app>-staging` | |
| `pnpm --filter <app> deploy:production` | `prajasabha-<app>-prod` | |

**The top-level config in each `wrangler.jsonc` is the `dev` environment,
deliberately**, so that a deploy which names no environment lands on a
throwaway dev Worker rather than the live site.

That is a safe *default*, not a guarantee. Wrangler resolves the target
environment as `--env ?? process.env.CLOUDFLARE_ENV`, so with
`CLOUDFLARE_ENV=production` exported in your shell or a CI job, a bare
`wrangler deploy` publishes **production**. The `deploy:dev` scripts therefore
pin `CLOUDFLARE_ENV=` empty rather than relying on it being unset.

**Use the `deploy:*` scripts, not raw `wrangler deploy`.** They are the
correctness mechanism, not a convenience — they pin the environment on both
the build and the deploy so the two cannot disagree.

## ⚠️ apps/web: the environment is chosen at BUILD time, not deploy time

`apps/web` uses Wrangler's *redirected configuration*: the Astro Cloudflare
adapter reads `wrangler.jsonc` at build time and writes a **flattened**
`dist/server/wrangler.json`, which is the config `wrangler deploy` actually
uses (`.wrangler/deploy/config.json` points at it).

That flattened file contains no `env` blocks — the environment is already
resolved. `--env` at deploy time cannot re-resolve it.

Wrangler does guard the obvious mismatch. The generated config records a
`targetEnvironment`, and supplying a *different* `--env` is a hard error:

```sh
CLOUDFLARE_ENV=staging pnpm --filter web build
pnpm --filter web exec wrangler deploy --env production
# ✘ ERROR  You have specified the environment "production" via the
#          `--env/-e` CLI argument …
```

Two gaps remain, because that check only fires when an environment name is
supplied at deploy time:

1. **Plain build, then `--env production`.** A plain `astro build` writes no
   `targetEnvironment`, so the check is skipped. The deploy proceeds using the
   baked dev config — including its baked `name` — and therefore *overwrites
   the dev Worker*. Not a production incident, but not the deploy you asked
   for, and nothing warns you.
2. **Build for production, then a bare `wrangler deploy`.** With no `--env`
   there is no name to compare, so the guard never runs and the production
   config ships. This is the direction that matters: a bare deploy is not
   inherently safe once a production build is sitting in `dist/`.

The environment is selected by the `CLOUDFLARE_ENV` variable **at build
time**:

```sh
CLOUDFLARE_ENV=production astro build && wrangler deploy --env production
```

`deploy:staging` / `deploy:production` in `apps/web/package.json` fuse those
two steps into one command precisely so the build environment and the deploy
environment cannot drift apart. Use them.

`apps/api`, `apps/jobs` and `apps/vault-svc` have no build step of this kind,
so a plain `wrangler deploy --env <env>` resolves bindings correctly for them.

## Deploy order

`vault-svc` → `jobs` → `web`.

`apps/web` holds service bindings (`VAULT_SVC`, `JOBS_SVC`) that reference the
other two Workers **by name**, so those must exist in the target environment
first. Service-binding names are per-environment
(`prajasabha-vault-svc-staging`, etc.) and must stay in lockstep with each
Worker's own per-env `name` field — a mismatch is how a staging deploy ends
up talking to the production identity vault.

Per HLD §8, `vault-svc` deploys are **manual-approval**, and forward-only
migrations are applied by a gated job *before* the corresponding Worker
deploy. Rollback is a previous Worker version plus a compensating migration,
never a history edit.

## Secrets

Secrets are non-inheritable and per-environment:

```sh
wrangler secret put SESSION_SECRET --env staging
wrangler secret put SESSION_SECRET --env production
```

Run these from the app's own directory. `.env.example` is the source of truth
for the full list of names (50 of them) and which app needs which — it is not
duplicated here, so there is one place to update when a story adds a value.

Never pass a secret as a shell argument or `echo` it into the command; use the
interactive prompt, or `wrangler secret put <NAME> --env <env> < file`.

### No value is reused across environments

This is an acceptance criterion of #18, not a preference. Reuse is actively
dangerous for these in particular:

| Secret | Why reuse breaks something |
|---|---|
| `SESSION_SECRET` | A staging session cookie would authenticate in production |
| `EMAIL_HASH_PEPPER`, `EPIC_HASH_PEPPER` | A shared pepper makes staging's data a lookup table for production's identity hashes |
| `EMAIL_ENCRYPTION_KEY`, `EPIC_ENCRYPTION_KEY`, `EPIC_DOC_ENCRYPTION_KEY` | One leaked key decrypts both environments' vault records |
| `VAULT_SVC_INTERNAL_TOKEN`, `JOBS_INTERNAL_TOKEN` | A leaked staging token would drive production service-to-service calls |
| `*_ADMIN_TOKEN` (issue merge, deliberation sweep, statement moderation) | Staging admin access would grant production admin access |
| `APP_DATABASE_URL`, `VAULT_SVC_DATABASE_URL` | Must point at different databases entirely — see #19 for the separate vault project |

`CLOUDFLARE_ACCOUNT_ID` is supplied per deploy context as an environment
variable rather than committed to `wrangler.jsonc`. HLD §8 wants separate
Cloudflare accounts for staging vs prod, and this is a public repo with
hostile readers assumed (CLAUDE.md invariant 6) — account identifiers are
needless reconnaissance.

## First-time bootstrap for an environment

Per environment (`staging`, then `production`):

1. **KV namespaces.** The `id` values in `wrangler.jsonc`'s env blocks are
   deliberately invalid placeholders (e.g. `REPLACE_WITH_WEB_STAGING_KV_ID`,
   `REPLACE_WITH_VAULT_SVC_STAGING_KV_ID`) so a premature deploy fails at
   config validation instead of silently binding to whatever namespace happens
   to exist. They are named per app on purpose — the two must not be filled in
   with the same id. Create and record the real ids:
   ```sh
   cd apps/web       && wrangler kv namespace create RATE_LIMIT_KV --env staging
   cd apps/vault-svc && wrangler kv namespace create RATE_LIMIT_KV --env staging
   ```
   `apps/web` and `apps/vault-svc` each need their **own** namespace — they
   rate-limit different endpoints and must not share a keyspace. Their local
   dev ids (`web-local-dev-placeholder`, `vault-svc-local-dev-placeholder`)
   are likewise distinct for the same reason.

   `deploy:dev` needs the same treatment if you ever want a *deployed* dev
   Worker: the top-level ids are Miniflare-only strings that work for
   `wrangler dev`, not real namespace ids. Create dev namespaces too, or
   treat `deploy:dev` as "the harmless target for an unqualified deploy"
   rather than a working environment.

2. **R2 buckets.** Names are already in the config; create them:
   ```sh
   wrangler r2 bucket create prajasabha-issue-photos-staging
   wrangler r2 bucket create prajasabha-deliberation-artifacts-staging
   ```
   Buckets are per environment so staging can never read or overwrite
   production evidence photos (citizen-submitted material) or published
   consensus artifacts.

3. **Secrets.** Set every name from `.env.example` for that environment, with
   freshly generated values — see the reuse table above.

4. **Migrations**, via the gated job, before the Worker deploy.

5. **Deploy** in order: `vault-svc` → `jobs` → `web`.

## Verifying a config without deploying

`--dry-run` validates config and resolves bindings, and needs no Cloudflare
login:

```sh
pnpm --filter jobs exec wrangler deploy --dry-run --env staging
```

It prints the resolved bindings, which is the fastest way to catch the most
likely mistake in this setup: bindings are **non-inheritable**, so an `env`
block that omits one deploys a Worker with that binding silently absent
rather than falling back to the top-level value.

For `apps/web`, inspect the generated config instead, since that is what
actually ships:

```sh
CLOUDFLARE_ENV=staging pnpm --filter web build
python3 -c "import json;c=json.load(open('apps/web/dist/server/wrangler.json'));print(c['name'],[b['bucket_name'] for b in c['r2_buckets']],[s['service'] for s in c['services']])"
```

## Public surface per Worker

| Worker | Publicly reachable? | Why |
|---|---|---|
| `web` | Yes | It is the site |
| `vault-svc` | **Yes — and broader than it should be** | See below |
| `jobs` | No | `workers_dev: false` **and** `preview_urls: false` |
| `api` | No | Same, plus it is still a stub |

`workers_dev: false` on its own is **not** enough to make a Worker private:
`preview_urls` is a separate inheritable key that defaults to `true` and
serves the Worker at `<version>-<name>.<subdomain>.workers.dev`. Both must be
false. Wrangler warns about the mismatch but suppresses that warning on first
deploy and in CI, so it is easy to believe a Worker is private when it is not.
This matters most for `jobs`, whose `POST /internal/sweep` is guarded by a
single factor (`JOBS_INTERNAL_TOKEN`, no IP allowlist) on the assumption that
it is unreachable except through the `JOBS_SVC` service binding.

### Known hardening gap: vault-svc's public hostname

`apps/vault-svc` deliberately keeps a public origin — the browser posts the
raw EPIC number and document straight to `/public/epic/submit`, which is HLD
§4.3's "separate origin" rule (that data must never transit `apps/web`'s
server). Turning the subdomain off would silently break T2 verification.

The gap is that the same hostname also exposes `/internal/registrations/*`
(bearer token only) and `/review/epic/*` (token + IP allowlist). The fix is a
custom domain with an explicit `routes` entry per environment so only
`/public/*` is publicly routable. Deferred: it needs real zones/domains that
do not exist yet. **Do not** "fix" it by setting `workers_dev`/`preview_urls`
to false on that Worker — that breaks EPIC verification. Narrow it with
`routes`.

## Not yet wired up

- **Hyperdrive.** Real Postgres connectivity from a Worker needs a Hyperdrive
  binding (HLD §8, and the note in `apps/vault-svc/wrangler.jsonc`). Not
  configured — deploys will not reach a real database until it is.
- **`routes` / custom domains**, which the vault-svc gap above depends on.
- **CI deploy job.** Explicitly out of scope for #18; deploys are manual for
  now.
- **Second Supabase project** for the vault (#19), India-pinned with
  dual-control keys.
- **`compatibility_date`** is `2025-01-01` on all four Workers and is stale.
  Bumping it changes runtime behaviour, so it belongs in its own change.
