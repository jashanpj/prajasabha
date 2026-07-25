# Data Protection & Security Design
## Praja — Citizen Democracy Platform

**Version:** 1.0 | **Date:** July 2026 | **Audience:** Legal counsel + Engineering (dual-use artifact)
**Parent docs:** Product & Strategy v1.0 · PRD v1.1 · Technical Architecture HLD v1.0
**Status:** Draft for counsel review — items marked ⚖️ require legal sign-off before build freeze

---

## 1. Why this document exists

Praja verifies real citizens against government identity documents and then hosts their political speech. That combination makes data protection an existential property, not a compliance checkbox:

- A breach that links **identity ↔ political opinion** harms users in ways money cannot remediate.
- The platform audits political actors, so it must expect **motivated legal and extra-legal attempts** to unmask users.
- Regulatory exposure (DPDP penalties up to ₹250 crore per breach category) can end the organization.

Design stance: **we cannot leak what we do not hold, and we cannot be compelled to disclose what we cannot ourselves reconstruct.** Data minimization is the primary security control; everything else is defense in depth.

---

## 2. Data inventory & classification

| Class | Data | Store | Sensitivity |
|---|---|---|---|
| C1 Identity | Aadhaar offline e-KYC fields (name, YoB, gender, district) — transient; uniqueness hash (HMAC of reference ID); EPIC hash; verification decisions | Vault DB only | Critical |
| C2 Contact | Phone (hashed for uniqueness + encrypted for OTP delivery), optional email | Vault DB (mapping) / Auth provider | High |
| C3 Civic activity | Issues, statements, votes (deliberation, bills, satisfaction), supports, RTI contributions — keyed to `member_id` + pseudonym | Participation DB | High (political opinion by nature) |
| C4 Public record | Published issues, ledgers, bills, receipts, minutes, moderation log | Participation DB + edge cache | Public by design |
| C5 Documents | Evidence photos, RTI responses, dispatch receipts | R2 | Mixed (PII-redacted before publish) |
| C6 Operational | Event log, access logs, rate-limit counters | Participation DB / CF | Internal |
| C7 Payment | Razorpay order/payment refs (no instruments stored) | Participation DB | Moderate (PCI scope with aggregator) |

**The critical join** — C1/C2 ↔ C3 — exists only inside `vault-svc` (HLD §4). No table, backup, log line, or analytics event may ever contain both an identity attribute and a civic-activity attribute. This is an enforced review rule on every schema migration.

⚖️ **Aadhaar note for counsel:** we use *offline* e-KYC under the Aadhaar (Sharing of Information) Regulations — user-initiated, no UIDAI authentication, no biometric, no Aadhaar number stored. We retain only an HMAC of the offline reference ID for uniqueness. Confirm this retention is compatible with offline e-KYC storage restrictions; if not, fallback design is a salted hash of (name+YoB+gender+district) tuple with weaker uniqueness guarantees.

---

## 3. DPDP Act 2023 compliance map

Praja (operating entity) is the **Data Fiduciary**. Users are Data Principals. Supabase, Cloudflare, MSG91, Razorpay, SES/Resend, Sentry are **Data Processors** under DPA contracts (§10).

| DPDP obligation | Implementation |
|---|---|
| Notice & consent (S.5–6) | Layered notice at each capture point (signup, T1, T2, RTI contribution): what is collected, purpose, retention, rights, DPO contact — in Malayalam and English. Consent records (timestamp, notice version, scope) in Vault DB; withdrawable in settings |
| Purpose limitation | Purposes enumerated per class in §2; identity data used solely for verification/uniqueness/constituency mapping — never for profiling, analytics, or comms targeting |
| Data minimization | Transient processing of KYC fields (§4 HLD); hashes over raw identifiers; pseudonymous participation; no advertising identifiers anywhere |
| Accuracy (S.8) | Self-service pseudonym/contact correction; EPIC re-verification flow on constituency change |
| Retention & erasure | Schedule in §5; erasure API in vault-svc executes across both DBs + backup exclusion-on-restore procedure |
| Data Principal rights (S.11–14) | Settings: access (export of own C3 data as JSON), correction, erasure, grievance channel with tracked SLA, nomination deferred ⚖️ (confirm applicability) |
| Grievance redressal | In-product grievance flow + DPO email; feeds the same tracked queue as IT-Rules grievances |
| Breach notification (S.8(6)) | Notify Data Protection Board + affected Principals per prescribed form/timeline; runbook §9. Note **CERT-In 6-hour reporting runs in parallel** (§9) |
| Children's data (S.9) | Platform is **18+ only** (voter verification presupposes majority). T&Cs state 18+; T0-only accounts claiming under-18 are refused. No tracking/targeting of any user regardless |
| Cross-border (S.16) | Permitted unless negative-listed; nonetheless: primary data at rest in Mumbai (both DBs), KYC compute pinned ap-south-1; edge-cached data is C4 public only. ⚖️ Watch negative-list notifications for CF/SES/Sentry regions |
| Significant Data Fiduciary | Not assumed at pilot scale; ⚖️ counsel to reassess at >1M users or on notification criteria (volume + sensitivity + risk to electoral democracy is precisely the S.10 factor set) — if designated: DPIA, independent audit, resident DPO obligations activate. Build DPIA at M2 regardless (cheap insurance) |
| SPDI Rules / S.43A | Superseded in practice by DPDP for our categories once fully in force; maintain SPDI-grade controls meanwhile ⚖️ |

---

## 4. Consent & notice architecture

- **Notice versions are content, not code:** stored, versioned, diffable; every consent record binds to a notice version.
- Granular consents: (a) account/verification, (b) transactional comms, (c) optional email updates. No bundled consent; declining (c) never blocks participation.
- **What we never ask consent for, because we never do it:** ad targeting, data sale, sharing identity with representatives/authorities, cross-site tracking. Stated in the notice affirmatively — this is a positioning asset, not just compliance.
- Withdrawal = same effort as grant (one screen); triggers scoped deletion or cessation per class.

---

## 5. Retention schedule

| Data | Retention | Disposal |
|---|---|---|
| Raw Aadhaar XML/ZIP | **0 persistence** — in-memory processing only | n/a (by construction) |
| KYC extracted fields | Discarded post-verification decision; only hashes + decision retained | Immediate |
| EPIC photo/doc uploads | Until review decision, max 30 days | Hard delete + R2 lifecycle |
| Uniqueness/EPIC hashes, consent records | Life of account + 90 days | Erasure job |
| Phone (encrypted) | Life of account | Erasure job |
| C3 civic activity (unpublished/private) | Life of account | Erased on request |
| C3 published contributions | **Anonymized, not deleted, on erasure** — pseudonym unlinked from vault, content persists as "former member" ⚖️ (public-record integrity vs. erasure right — needs counsel position in T&Cs) |
| C4 public record (ledgers, receipts, draws, mod-log) | Permanent — append-only civic record | n/a |
| Event log (C6) | 24 months rolling (≥180 days per CERT-In directions) | Partitioned drop |
| Access/infra logs | 180 days (CERT-In minimum) | Auto-expiry |
| Payment refs | 8 years (tax/audit) ⚖️ confirm | Archived cold |
| Backups | 35 days PITR + 12 weekly encrypted dumps; erasure honored via restore-time exclusion list | Key destruction |

---

## 6. Threat model

Assets at stake: (A1) identity↔opinion linkage, (A2) ledger integrity, (A3) deliberation integrity, (A4) availability during politically sensitive moments, (A5) organizational continuity.

| Adversary | Capability | Goals | Primary controls |
|---|---|---|---|
| **State-adjacent actor** | Legal compulsion, infra pressure, sophisticated intrusion | Unmask critics (A1), chill participation, take platform down (A4) | Vault separation + dual-control keys; minimum-holdings design; disclosure runbook §8; jurisdiction-aware counsel; Project Galileo; static-cache survivability (public record stays served from edge even if origin is down) |
| **Party IT cells** | Coordinated humans, real credentials, harassment ops | Distort deliberations/sentiment (A3), doxx opponents, flood moderation | One-human-one-account (T1 hash), participant-only satisfaction ratings, velocity/cluster anomaly flags (review-not-delete), pseudonymity, mod-log transparency, statement character limits + civility-only review |
| **SLAPP litigant** | Defamation suits, discovery demands | Obtain identities via court order, impose cost (A5) | Facts-only ledger design (no composite scores), right-of-reply, counsel retainer + insurance, §8 runbook: narrow-scope response, challenge overbroad orders, user notification where lawful |
| **Insider / compromised admin** | Legitimate access | Exfiltrate A1, tamper A2 | Dual-control vault keys, no laptop DB access (Hyperdrive-only), append-only ledger tables (DB-level REVOKE), vault access alerting, least-privilege admin roles, background separation of vault vs. platform admins |
| **Criminal actor** | Commodity intrusion, ransomware | Data theft/extortion | Standard hardening (§7), backups + restore drills, minimal monetizable data (no cards, no raw IDs) |
| **Opportunist / researcher** | Scraping, probing public code | Embarrass, resell public data | Open-data API as sanctioned channel; assume-hostile-reader code policy (STACK.md); coordinated disclosure policy + security.txt |

**Design consequence worth stating plainly:** the strongest answer to both the state actor and the SLAPP litigant is identical — *the vault cannot answer questions it was never designed to answer.* There is no query that returns "who wrote statement X" without dual-key vault access, and no query anywhere that returns Aadhaar numbers, because none are stored.

---

## 7. Security controls (engineering summary)

- **Identity plane:** per HLD §4 — pinned region, in-memory KYC, HMAC pepper in split custody, four-operation API surface, mTLS/service tokens, IP-allowlisted admin, full access audit with founder alerting.
- **Application:** RLS on every table; writes only via endpoints (audit + rate limits + Turnstile); Zod validation at every boundary; CSP (Astro 6 auto), no third-party scripts on public pages; EXIF stripping on upload; PII-redaction review step before any C5 document publishes.
- **Abuse:** OTP endpoint = Turnstile + per-phone cooldown + ASN rate rules + SMS spend alarm; per-member mutation rate limits in KV; anomaly jobs flag, never auto-delete.
- **Ledger integrity:** append-only tables enforced by DB grants; compensating-event corrections; sortition draws reproducible from published seed + pool snapshot; nightly hash-chain checkpoint of `event_log` published (tamper-evidence, cheap).
- **Ops:** Wrangler secrets only; no secrets/thresholds in the public repo; Dependabot + audit CI; staging/prod isolation with separate Supabase projects and CF accounts; NTP per CERT-In direction; restore drill pre-launch and quarterly.
- **Availability:** SWR caching means the public record survives origin loss; election-week freeze policy on risky deploys; Galileo escalation path.

---

## 8. Identity escrow & disclosure runbook ⚖️

Trigger: any legal demand (court order, police notice, S.91 CrPC/BNSS equivalent, DPDP Board direction) seeking user identity or non-public data.

1. **Intake:** only DPO + designated counsel may receive/handle; log in demands register (feeds transparency report).
2. **Validity review (counsel):** jurisdiction, authority, specificity, proportionality. Overbroad or informal requests → challenge/clarify; nothing is disclosed on phone calls or emails without process.
3. **Scope minimization:** if valid, produce the *minimum* responsive records. Note structurally: participation DB alone yields pseudonymous records; identity linkage requires the dual-control vault procedure — two named officers, logged, counsel present.
4. **User notification:** notify the affected user before or promptly after disclosure **unless legally prohibited**; where gagged, disclose in aggregate via transparency report when permitted.
5. **Records:** every demand, decision, and disclosure appended to internal register; semi-annual **transparency report** publishes counts by type/outcome.
6. **Emergency exception:** imminent-threat-to-life requests follow the same officers-plus-counsel path on an accelerated clock; never a solo decision.
7. **Refusal posture:** where law permits, contest; budget line for litigation exists from day one (this is what the counsel retainer and insurance are for).

⚖️ Counsel to convert this into a formal SOP with statutory citations and gag-handling detail.

---

## 9. Incident response

**Clocks that run in parallel — pre-drafted templates for each:**
- **CERT-In:** report designated cyber incidents within **6 hours** of noticing; 180-day log retention and time-sync already in §7.
- **DPDP:** breach intimation to the Data Protection Board and to each affected Data Principal, per prescribed form.
- **Users/public:** plain-language notice in Malayalam + English; no minimizing language; publish post-mortem for any incident touching C1–C3.

Runbook: sever (rotate vault keys, revoke tokens, isolate service) → assess linkage risk (was the C1↔C3 join ever exposed? — the single question that defines severity) → notify per clocks → remediate → post-mortem to oversight board. Tabletop exercise before public launch; repeat semi-annually.

---

## 10. Processors & vendor posture ⚖️

| Processor | Data touched | Region | Notes |
|---|---|---|---|
| Supabase | C1 (vault project) / C2–C3 (platform project) | Mumbai | DPA; separate projects = separate blast radius |
| Cloudflare | C4 cache, C6 edge logs, TLS | Global edge / Smart Placement | DPA; no C1 transits CF beyond TLS to vault ingress ⚖️ verify ingress path |
| MSG91 (SMS) | Phone numbers (delivery) | India | DLT-registered; DPA |
| Razorpay | C7 | India | PCI handled by aggregator |
| SES/Resend | Email addresses | ap-south-1 preferred | DPA |
| Sentry | Stack traces — **PII scrubbing on, no request bodies** | ⚖️ region choice | Scrub rules in code review checklist |

Vendor rule: any new processor requires DPO sign-off + this table updated + notice version bump if user-visible.

## 11. Governance

- **DPO named before M2** (public contact in notices and on-site).
- Quarterly internal audit: schema-migration join-rule check, vault access log review, retention-job verification, RLS coverage diff.
- Annual external security audit + pen test (pre-launch pen test per PRD).
- DPIA drafted at M2; refreshed on any new data category, on SDF designation, or before multi-constituency expansion.
- Oversight board receives: transparency report, incident post-mortems, audit summaries.

---
*End v1.0. Sign-off required from: legal counsel (⚖️ items), DPO (on appointment), engineering lead. This document, minus §8 operational details, is publishable — and publishing it is recommended: for this platform, the security design is part of the product's argument.*
