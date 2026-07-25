# Technical Architecture Document (HLD)
## PrajaSabha — Citizen Democracy Platform, Pilot MVP

**Version:** 1.1 | **Date:** July 2026
**Parent docs:** Product & Strategy v1.0 · PRD v1.1 · STACK.md (accepted with amendments in §2)
**Stack baseline:** Astro 6 on Cloudflare Workers · Supabase Postgres (Mumbai) · Drizzle · R2 · TypeScript strict

---

## 1. Architecture Overview

```
                                   ┌─────────────────────────────────────────┐
                                   │            CLOUDFLARE EDGE              │
  Citizens (mobile web) ──────────▶│  apps/web   Astro 6 Worker (SSR+assets) │
  MP office (desktop)   ──────────▶│             cache API · KV · Turnstile  │
  Public / researchers  ──────────▶│  apps/api   Hono Worker (open data, /v1)│
                                   │  apps/jobs  Cron Worker (batch, clocks) │
                                   └───────┬───────────────┬─────────────────┘
                                           │ Hyperdrive    │ R2 (docs, images)
                                           ▼               │
                              ┌────────────────────────┐   │
                              │  PARTICIPATION DB      │   │
                              │  Supabase PG (Mumbai)  │◀──┘ (keys only; R2 is blob,
                              │  RLS · event log ·     │      PG is index)
                              │  FTS/trgm · PostGIS    │
                              └────────────────────────┘
        ═══════════════ hard trust boundary — no FK, no join, opaque member_id ═══════════════
                              ┌────────────────────────┐
  DigiLocker / Aadhaar XML ──▶│  IDENTITY VAULT        │  Pinned to India region
  EPIC review (admin) ───────▶│  vault-svc (ap-south-1)│  Separate Supabase project /
                              │  + Vault DB (Mumbai)   │  managed PG. Own secrets, own
                              └────────────────────────┘  access logs, dual-control keys.

  External: MSG91 SMS (DLT) · Razorpay UPI · SES/Resend email · Sentry · CF Web Analytics
```

Three planes:

1. **Public plane** (99% of traffic): prerendered + cached Astro pages — issues, ledgers, bills, panel, receipts. Served from edge cache; Postgres never sees a spike.
2. **Participation plane** (authed writes): OTP-authed citizens and MP offices; every mutation via Astro API endpoints → audit trail, rate limits, Turnstile.
3. **Identity plane** (isolated): verification only. Physically and administratively separated from everything else (§4).

---

## 2. Stack Review — Accepted, with Required Amendments

The proposed STACK.md is accepted as the baseline. It is genuinely well-reasoned — the Hyperdrive→Supavisor session-mode note, R2-for-PDF-egress, cache-hit-ratio-as-the-cost-variable, and Manjari subsetting are all correct calls, and Astro 6 islands is a *better* fit than the PRD's provisional Next.js for a read-heavy, low-bandwidth product (PRD §5 superseded accordingly). The following amendments are **required** to make the stack match the PRD:

| # | STACK.md says | Change required | Why |
|---|---|---|---|
| A1 | Auth = email magic link + Google OAuth | **Phone OTP is the primary T0 method** (Supabase Auth phone provider → MSG91/Twilio). Email magic link = fallback/recovery. **Drop Google OAuth from MVP** | PRD Module A1 defines T0 as phone OTP. Google OAuth adds an identity path that bypasses the tier model and adds a US-provider dependency for a politically exposed platform |
| A2 | Single Supabase Postgres | **Add the Identity Vault as a separate deployment** (second Supabase project or managed PG, Mumbai) + `vault-svc` pinned to India | PRD A4 is a hard requirement: participation and identity stores must be joinable only through the vault service. One database = one breach = both |
| A3 | (absent) | **Payments:** Razorpay (UPI) server-side orders + webhook endpoint in apps/web Worker; no card storage | PRD Module L2 RTI crowdfund |
| A4 | (absent) | **Transactional comms:** SES (ap-south-1) or Resend for email; **TRAI DLT registration for SMS sender ID + templates — start immediately, takes weeks** | PRD Module J. DLT is the long-lead item; OTP delivery in India fails without it |
| A5 | Queues/DO deferred | Keep deferred, but **add Cron Triggers Worker (`apps/jobs`) now** | Needed at MVP for: consensus clustering batch, response-clock breach flags (30/60/90d), RTI statutory-deadline checks + first-appeal drafts, scorecard cache purges |
| A6 | Workers global execution | **Enable Smart Placement** on web Worker; **pin all KYC processing to `vault-svc` in ap-south-1**; Aadhaar XML processed **in-memory only, never persisted** | DPDP posture + Aadhaar-ecosystem norms. General page rendering at global edge is fine; identity documents should not transit non-India compute |
| A7 | Turnstile on forms | Explicitly **Turnstile + strict rate limits on the OTP-request endpoint** | SMS-pumping attacks are a real cost/DoS vector on Indian OTP endpoints |
| A8 | CF Web Analytics only | Accepted for web analytics; **product funnels come from our own append-only event log** (§6), not a third-party product-analytics tool | Verification-funnel metrics are a PRD success criterion; the event log already captures them with zero extra privacy surface |
| A9 | Workers Free budget math | **Go Workers Paid ($5/mo) from day one** | Removes daily-cap cliff during press moments; Queues/Smart Placement need it anyway |
| A10 | (absent) | **Election-period mode** = KV flag checked in ledger/sentiment render paths + cache-tag purge on toggle | PRD F4 acceptance criterion |

Everything else in STACK.md — Biome, pnpm workspaces, Drizzle, PG FTS with `simple` + trigram for Malayalam, Hono open-data API as a separate Worker, docker-compose fork story, Project Galileo application — is adopted unchanged.

---

## 3. Service Decomposition

| Service | Runtime | Responsibility |
|---|---|---|
| `apps/web` | Astro 6 Worker | All pages (public prerendered/cached + authed SSR), all mutation API endpoints, Razorpay webhooks, Turnstile checks |
| `apps/api` | Hono Worker | Public open-data API `/v1` — read-only, API-keyed, separately rate-limited; cannot degrade the site |
| `apps/jobs` | Cron Worker | Consensus clustering (hourly during open deliberations), response-clock flags (daily), RTI deadline watcher + first-appeal draft generation (daily), ledger stat refresh, cache-tag purge queue |
| `vault-svc` | Pinned service, ap-south-1 (Supabase Edge Function pinned / small container / Lambda — decide at M0 spike) | Aadhaar offline e-KYC ZIP+XML signature validation, uniqueness-hash issuance, EPIC review workflow API, DPDP erasure execution, escrow disclosure workflow |
| `packages/db` | lib | Drizzle schema + migrations for **participation DB only** |
| `packages/vault-db` | lib | Separate Drizzle schema for vault DB; never imported by web/api/jobs |
| `packages/shared` | lib | Zod validators, types, constants (quorums, thresholds — config-driven) |

---

## 4. Identity Vault — the load-bearing design

### 4.1 Separation model
- **Two databases, two Supabase projects, two sets of credentials.** Participation DB knows a user only as `member_id` (UUIDv7) + tier + constituency + ward + pseudonym. Vault DB maps `member_id → verification records`. No shared connection string exists in any Worker except `vault-svc`.
- `vault-svc` exposes exactly four internal operations (mTLS/service-token authed, called only by `apps/web` server-side):
  1. `verifyAadhaarXml(zip, shareCode) → { ok, uniqueness_hash_exists }`
  2. `submitEpic(member_id, epic_no, doc_ref) → review_queue`
  3. `confirmTier(member_id) → { tier, constituency, ward }`
  4. `eraseMember(member_id)` (DPDP)
- **Dual-control:** vault DB service-role key split — half in Wrangler secret of `vault-svc`, half in KMS/environment released at deploy; no single admin can read the vault from a laptop. All vault reads append to an access log alerting to founders.

### 4.2 Aadhaar offline e-KYC flow
1. Browser uploads ZIP + share code **directly to `vault-svc`** (signed one-time URL) — the file never touches `apps/web` or R2.
2. `vault-svc` (in-memory): unzip with share code → validate UIDAI XML-DSig against pinned UIDAI cert → extract {name, YoB, gender, district} → compute `uniqueness_hash = HMAC-SHA256(k_pepper, referenceId)` → check collision → write verification record → **discard raw XML** (never written to disk/object storage; ≤24h purge requirement met by construction).
3. Returns only `{ok, tier:T1}` to `apps/web`, which updates the participation DB.
- XML-DSig verification is Node-library territory (canonicalization); this is why `vault-svc` may need `nodejs_compat` or a container rather than a vanilla Worker — **M0 spike decides**, with the container path as the safe default.

### 4.3 EPIC / T2
- EPIC number + DigiLocker doc or photo → vault review queue (admin UI served by `vault-svc`, separate origin, separate auth, IP-allowlisted).
- On approval: vault stores EPIC hash; participation DB receives `{tier:T2, constituency, assembly_segment, ward}` only. Photo docs deleted on decision.

### 4.4 Breach blast-radius statement (required by PRD A4)
- Participation DB breach: pseudonymous civic activity + phone-hash — no names, no Aadhaar/EPIC data.
- Vault DB breach: verification hashes + minimal KYC fields — no civic activity, no opinions, no votes.
- Both simultaneously + pepper compromise is required to deanonymize participation. Document this in the Security Design doc with the threat model (state-level actor, SLAPP discovery, insider).

---

## 5. Data Model (participation DB — core tables)

```
members(member_id, pseudonym citext, tier, constituency_id, ward_id, created_at)
issues(issue_id, slug, title_ml, title_en, body, category, ward_id, status,
       merged_into, support_t2_count, created_by → members)
issue_support(issue_id, member_id, ward_id, created_at)            -- unique(issue,member)
authorities(authority_id, kind{councillor|ulb|mla|mp|dept|agency}, name_ml, name_en)
routings(issue_id, authority_id, role{responsible|copied}, legal_basis_ref)
deliberations(delib_id, issue_id, state, opens_at, closes_at)
statements(stmt_id, delib_id, member_id, text, mod_state)
statement_votes(stmt_id, member_id, vote{agree|disagree|pass})     -- unique(stmt,member)
consensus_runs(run_id, delib_id, method, params, results jsonb, ran_at)
panels(panel_id, constituency_id, term_start, term_end)
panel_members(panel_id, member_id, role, ward_id)
sortition_draws(draw_id, panel_id, seed, algo_version, pool_snapshot_ref, published_at)
representations(rep_id, issue_id, doc_r2_key, created_by_panel)
transmissions(tx_id, rep_id|bill_id, authority_id, sent_at, channel, receipt_r2_key)
tx_status_events(tx_id, status, evidence_r2_key, at)               -- append-only
bills(bill_id, code, title, summary_ml/en, draft_r2_key, delib_id, state)
bill_votes(bill_id, member_id, vote{support|amend|oppose}, comment)
rtis(rti_id, issue_id, authority_id, template_id, body, state, ref_no,
     filed_at, statutory_due, response_r2_key)
rti_contributions(rti_id, member_id, amount, payment_ref)
responses(resp_id, tx_id|issue_id, office_id, kind, body, evidence_r2_key,
          published_at, edit_history jsonb)
satisfaction_ratings(resp_id, member_id, satisfied bool, month)    -- unique(resp,member)
offices(office_id, authority_id, verified_at)   staff_seats(office_id, member_id, name_on_record)
scorecard_stats(authority_id, session, metric, value, source_url, entered_by)
event_log(event_id, at, actor_member_id?, kind, subject_type, subject_id, payload jsonb)
moderation_actions(action_id, subject, rule_cited, action, public_note, at)
```

**Append-only enforcement:** `event_log`, `tx_status_events`, `sortition_draws`, `moderation_actions` — `REVOKE UPDATE, DELETE` from all roles including service role at the DB level; corrections are new compensating events. This is what makes the public ledger and timelines trustworthy.

**RLS sketch:** public tables readable by `anon` where `status='published'`; all writes denied to `anon`/`authenticated` roles directly (writes only via endpoints using service role after validation) — matching STACK.md's "writes through API endpoints" rule; per-member read of own private rows (e.g., own draft issues) via `auth.uid() = member_auth_uid`.

---

## 6. Module → Architecture mapping (PRD v1.1)

| PRD Module | Where it lives | Notes |
|---|---|---|
| A Identity | Supabase Auth (phone OTP) + vault-svc | §4; Turnstile on OTP request; DLT sender ID |
| B Issues/Router | web endpoints + `routings` rules table | Router = SQL rules table (category×ward→authorities) editable in admin; explainers in Content Collections |
| C Deliberation | web islands + `apps/jobs` clustering | Voting UI = React island (`client:visible`); clustering = hourly cron: PCA + 2-means over vote matrix in TS (≤5k×50 matrix — milliseconds; no Python needed). Fallback per PRD: plain agreement % if spike fails |
| D Panel/Sortition | jobs + published artifacts | Draw = deterministic function(seed, pool_snapshot, strata); seed = published; verify-the-draw page re-runs it client-side from published JSON |
| E Transmission | web endpoints + R2 receipts | Physical dispatch logged by admin; PDFs generated server-side (see §8 PDF note) |
| F Ledger | prerendered/cached pages + jobs stat refresh | Election-mode KV flag gates F3 blocks; cache-tag purge on toggle |
| G MP console | authed SSR + islands | Desktop-only route group; office auth = same Supabase Auth + `staff_seats`; reach counts from event_log aggregates |
| H Moderation | admin routes + `moderation_actions` | Public mod-log page prerendered hourly |
| I Literacy | Content Collections (ml/en) | Pure prerender |
| J Notifications | jobs + SES/Resend + SMS (critical only) | Digest emails batched; SMS budget cap alarm |
| K Bills | web + R2 drafts + `bill_votes` | Quorum config in `shared`; amendment cycles as bill states |
| L RTI | web + Razorpay + jobs deadline watcher | Auto first-appeal = jobs generates draft → volunteer review queue |

---

## 7. Caching & Cost (adopting STACK.md §5, with tags)

- Public pages: `s-maxage=600, stale-while-revalidate=86400`, purge by **cache tag** on publish events (`issue:{id}`, `ledger:{authority}`, `bill:{id}`, `modlog`).
- KV: constituency/ward/authority lookups, election-mode flag, config (quorums).
- R2: all PDFs/images behind custom domain, immutable, content-hashed keys; lifecycle rule deletes orphaned upload prefixes at 7 days.
- Instrument cache-hit ratio from day one (Workers Analytics) — it is the cost KPI per STACK.md; alert if < 90%.

---

## 8. Cross-cutting decisions

- **PDF generation** (representations, receipts, consensus reports): not in Workers — generate via `apps/jobs` using a container-compatible path or pre-render HTML→PDF through a self-hosted Gotenberg on the same VPS class as `vault-svc` if container route chosen at M0. Keep it out of request path (async, linked when ready).
- **Image handling:** uploads → web endpoint → strip EXIF (wasm) → R2; CF Images for variants.
- **i18n:** as STACK.md; `ml` default. All status chips/labels centralized in `shared` so ledger language is consistent (the "No response — 84 days" strings are product law).
- **Feature flags/config:** thresholds (Concern=100, quorum=20%, term=6mo) in KV-backed config with admin UI — PRD marks them configurable.
- **Environments:** `dev` (docker-compose PG incl. a local vault schema), `staging` (separate CF account + separate Supabase projects), `prod`. Wrangler environments; no shared secrets across envs.
- **Migration deployment (from Dev Playbook):** migrations are forward-only, applied by a gated GitHub Actions job (manual-approval environment) *before* the corresponding Worker deploy; `vault-svc` deploys are always manual-approval; rollback = previous Worker version + compensating migration, never history edits.
- **Backups/DR:** Supabase PITR on Pro when live; weekly logical dumps of participation DB to R2 (encrypted); vault DB dumps to a separate bucket with separate keys; restore drill before public launch.

## 9. Security & Threat Model (summary — full detail in Security Design doc)

| Threat | Control |
|---|---|
| DDoS / press-spike | Edge cache + SWR; Workers Paid; **Project Galileo application at M2** (site must be live to apply) |
| SMS pumping on OTP | Turnstile + per-IP/ASN rate rules + per-phone cooldown + daily SMS spend alarm |
| Brigading | T2 gating, unique-vote constraints, velocity anomaly flags (jobs), satisfaction ratings restricted to issue participants |
| Scraping | open-data API is the sanctioned path; site-side bot rules; don't fight read-scraping of public data hard — it's public by design |
| SLAPP / legal discovery | Vault separation limits what any subpoena of the participation DB can reveal; disclosure runbook + counsel |
| Insider | Dual-control vault keys, access logging, no prod DB access from laptops (Hyperdrive only from Workers) |
| Supply chain | Public repo: Dependabot, pnpm audit, lockfile CI, no secrets/thresholds in Git (per STACK.md) |
| Codebase scrutiny | Assume hostile readers; policies in DB/dashboard, code teaches nothing exploitable |
| AI-assisted dev pipeline | claude-code-action in CI triggers **only on maintainer-association @mentions**, never on fork PRs with secrets (prompt-injection + cost surface); local hooks enforce vault/append-only invariants deterministically; human review of record on every merge (Dev Playbook §2–3) |

## 10. Open items → M0 spikes (2 weeks)

1. **vault-svc runtime decision:** Workers+nodejs_compat vs. container (Aadhaar XML-DSig + share-code unzip PoC decides). Container on a Mumbai VPS/Fly/Lambda is the safe default; also hosts Gotenberg (PDF).
2. Supabase Auth phone provider vs. custom OTP table + MSG91 direct (custom gives DLT template control; decide by cost + failure-mode test).
3. Clustering PoC in TS on synthetic 5k×50 vote matrix; validate against Pol.is reference output.
4. Razorpay sandbox: order→UPI→webhook→ledger entry round trip.
5. DLT registration filed (longest lead time — do first).
6. Hyperdrive + Supavisor session-mode smoke test from Workers (per STACK.md warning).
7. Draw determinism: implement draw fn + publish/verify page PoC.

---
*End HLD v1.1 (adds migration-deployment gating and AI-pipeline threat row from the Dev Process Playbook). Companion doc to follow: Data Protection & Security Design (threat model detail, DPDP data-flow maps, escrow disclosure runbook, retention schedule).*
