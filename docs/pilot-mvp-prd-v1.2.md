# Product Requirements Document (PRD)
## Citizen Democracy Platform — Pilot MVP (v1, Expanded Scope)

**Version:** 1.2 | **Date:** July 2026 | **Owner:** Product/Engineering
**Parent doc:** Product & Strategy Document v1.0 | **Design reference:** Praja design package (Claude Design, Jul 2026)
**v1.2 change note:** consistency revision aligning the PRD with HLD v1.0 (stack), Data Protection & Security Design v1.0 (KYC persistence, erasure policy, CERT-In), and the Dev Process Playbook (delivery pipeline). No feature-scope changes.
**Scope decision (v1.1 revision):** Following design review, ALL designed features are in v1 — including **Model Bills & Ratification (Module K)** and **RTI (Module L)**, previously deferred. MVP now delivers the full loop up to and including citizen-ratified model bills.
**Platform decision:** Mobile-first responsive **React web app** (Next.js). Native apps (React Native) deferred to post-pilot.
**Brand (working):** Praja / പ്രജ — pending trademark check.

---

## 1. Purpose & Goals

Build and launch the pilot MVP in **one Lok Sabha constituency**, proving one complete accountability loop end-to-end:

> Verified citizen raises issue → routed correctly → deliberated → formal representation transmitted → representative response recorded on public ledger.

### Success criteria (Pilot exit, ~6 months post-launch)
| Metric | Target |
|---|---|
| T2 Verified Constituents | ≥ 5,000 |
| Constituency Concerns formed (≥100 supporters) | ≥ 15 |
| Deliberations with ≥300 participants | ≥ 5 |
| Formal representations transmitted | ≥ 10 |
| Representative responses recorded | ≥ 3 |
| Model bills ratified & transmitted | ≥ 1 |
| RTIs filed with responses published | ≥ 3 |
| **Completed accountability loops (north star)** | **≥ 3** |
| Verification funnel completion (start→T2) | ≥ 40% |
| Repeat participation (30-day return, T2 users) | ≥ 35% |

### Non-goals for MVP
- No B2G white-label deployment
- No native mobile apps
- No multi-constituency support beyond data-model readiness
- No payment methods beyond UPI for RTI crowdfunding
- No ML-based routing (rules table only)

---

## 2. Users & Personas

| Persona | Description | Primary jobs |
|---|---|---|
| **P1 Resident (T0/T1)** | Curious citizen, mobile browser, Malayalam-preferring, moderate digital literacy | Browse issues, verify, support issues |
| **P2 Verified Constituent (T2)** | Engaged local; RWA member, student, professional | Raise issues, deliberate, vote, join volunteer pool |
| **P3 Panel Member** | T2 user drawn via sortition from opt-in pool | Prioritize backlog, steward deliberations, approve representations |
| **P4 MP Office Staff** | Representative's aide; desktop user; time-poor | Triage issue inbox, post official responses |
| **P5 Moderator** | Platform staff/trained volunteer | Review flagged content, log actions publicly |
| **P6 Admin** | Core team | Configure constituency, run sortition draws, manage transmissions |

---

## 3. Feature Scope — v1 (Expanded)

### Module A — Identity & Verification (Tiered)

**A1. T0 Registration (Phone OTP)**
- Phone number + OTP (SMS); pseudonym selection at signup; Malayalam/English language choice.
- AC: Duplicate phone blocked; rate-limited OTP; pseudonym uniqueness enforced; profanity/party-name filter on pseudonyms.

**A2. T1 Verification (Aadhaar Offline e-KYC)**
- User uploads Aadhaar Offline e-KYC XML/ZIP + share code, or DigiLocker consent pull (if partner access available at build time; XML upload is the guaranteed path).
- Validation is performed by the **identity vault service (vault-svc, India-pinned — HLD §4)**: signature check, field extraction, uniqueness hash (HMAC of reference ID). **Raw XML/ZIP is processed in-memory only and is never persisted** to disk, object storage, or logs (Security Design §5 — zero-persistence by construction, superseding the earlier ≤24h purge standard).
- AC: One Aadhaar hash = one account (collision → support flow); upload goes directly to vault-svc (never transits the web app); user sees exactly which fields were read; consent record stored per DPDP.

**A3. T2 Verification (EPIC / Voter ID → Constituency)**
- EPIC number entry + DigiLocker document or photo upload; manual review queue for MVP (OCR-assist optional); maps user to assembly segment + Lok Sabha constituency.
- AC: T2 badge shows constituency name; mismatched constituency users get read-only + "your constituency coming soon" state; review SLA ≤72h.

**A4. Identity Vault Separation (architectural requirement)**
- Identity data (hashes, verification records, encrypted escrow) lives in a **separate datastore/service** from the participation store. Participation records reference an opaque member ID only. No join possible without vault service + dual-control keys.
- AC: Documented breach blast-radius analysis; access to vault logged and alertable; erasure request flow (DPDP) implemented.
- **Erasure policy for published content (from Security Design §5, ⚖️ pending counsel):** account erasure deletes identity/vault records and private data; **published contributions are anonymized, not deleted** — pseudonym unlinked, content attributed to "former member" — preserving the integrity of the public civic record. Settings include self-service export (own data as JSON), erasure request, and this policy stated plainly.

### Module B — Issue Intake & Responsibility Router

**B1. Raise an Issue** (T1+)
- Title, description (Malayalam/English), category, location (ward/landmark), up to 5 photo attachments.
- AC: Draft autosave; image EXIF stripped; PII-in-image warning shown.

**B2. Responsibility Router (multi-authority)**
- Rule-based classifier (category × location) assigns one or more responsible authorities: Councillor / Municipality-Panchayat / MLA / MP / Department / Agency (KSRTC, PCB, NHAI…), with plain-language explainer card citing the legal basis (e.g., Kerala Municipality Act, 1994).
- **Multi-level routing (from design):** issues spanning levels are delivered to every responsible authority and tracked separately; ward councillor auto-notified; MP may be "copied for information only" — a distinct, clearly-labeled status.
- MVP: curated rules + authority registry table maintained by admin; ML later.
- AC: Every issue displays authority chip(s) + explainer; "copied for information" visually distinct from "responsible"; user can flag misrouting → admin review.

**B3. Support & Dedup**
- T2 users "Support" issues (one per user per issue). Semantic-similarity suggestion on creation: "Similar issue exists — support it instead?" Admin/panel can merge; supporter counts pool on merge; merged issues show attribution ("Raised by 14 constituents, merged").
- **Ward-level support breakdown (from design):** support counts displayed per ward (e.g., "Edappally 1,204 · Kalamassery 812 · other wards 1,188").
- AC: Support counts show T2-verified count distinctly; merge preserves both threads' history; supporter pseudonyms listed publicly, never names.

**B5. Issue Timeline (from design)**
- Every issue page shows an event timeline: created → promoted → deliberation opened/closed → consensus published → delivered per authority → responses → status changes.
- AC: Timeline entries generated from the append-only event log; no manual edits.

**B4. Constituency Concern Threshold**
- ≥100 T2 supporters → issue auto-promotes to **Constituency Concern**, enters panel backlog, becomes eligible for deliberation.
- AC: Threshold configurable per constituency; promotion event notifies supporters.

### Module C — Deliberation Engine

**Decision:** MVP ships **statement voting with basic 2-cluster analysis** (Pol.is-style, using open-source Pol.is math or equivalent), not full multi-cluster UI. If clustering spike fails timeline, fallback = statement voting + overall agreement %, clustering added v1.1.x.

**C1. Statement Submission & Voting**
- On any Concern in deliberation: T2 users submit statements (≤280 chars, moderated queue) and vote Agree/Disagree/Pass on others'; randomized serving; no replies, no threads.
- AC: One vote per statement per user; own statements not votable by author; participation counter always visible.

**C2. Consensus Surface**
- "Broad agreement" section: statements with ≥70% agreement across ≥ configurable N voters (and, if clustering live, agreement across both clusters).
- AC: Sample size + T2 share displayed on every percentage; export of consensus summary (PDF) for representation drafting.

**C3. Deliberation Lifecycle**
- States: Open (14 days default) → Extended (panel) → Closed → Summarized. Summary artifact generated for the representation.

### Module D — Steering Panel & Sortition (opt-in pool)

**D1. Volunteer Pool Opt-in** — T2 users join pool; declare ward, availability, optional expertise; can leave anytime.
**D2. Sortition Draw (admin-run, publicly verifiable)**
- Stratified random draw (ward, age band, gender) from pool; published seed + algorithm; **12 members; 6-month term** (revised from 90 days to match design and bill-drafting timelines — confirm at M1); cooling-off 1 term.
- **Eligibility bar (from design):** panel members cannot hold office in any political party; self-declaration at opt-in + public challenge window after draw.
- **Public "Verify the draw" page (from design):** anyone can re-run the published seed + algorithm against the published (pseudonymous) pool snapshot and reproduce the selection.
- AC: Draw page shows pool stats vs. constituency demographics; selected members accept within 7 days else redraw for slot; member cards show pseudonymous ID + ward + term month.
**D3. Panel Workspace & Roles (from design)**
- Named roles assigned within panel: Convener (per deliberation), Drafting group, Minutes & records, Evidence review, Responsibility routing.
- Backlog prioritization, deliberation stewardship (extend/close), representation & bill-draft approval vote (simple majority), RTI template review (see L1), minutes upload (published).
- AC: All panel actions and role assignments logged to public panel page.

### Module E — Formal Representation & Transmission

**E1. Representation Composer**
- Template: problem statement (from issue), evidence annex (attachments), deliberation summary (from C2 export), ask/recommendation. Drafted by panel + admin support.
**E2. Transmission & Public Receipt (multi-authority)**
- Sent via registered email + physical dispatch (offline, logged by admin); public receipt page per addressee: date, authority, document PDF, status. One representation may fan out to multiple authorities, each tracked separately.
**E3. Status Tracker**
- Per authority: Delivered → Acknowledged → Action reported → Closed / No response (auto-flag at 30/60/90 days).
- AC: Status history immutable (append-only); every status change timestamped and evidenced (upload of reply letter/screenshot).

### Module F — Accountability Ledger (Representative & Authority Profiles)

**F1. Objective Scorecard (MP)**
- Attendance, questions, debates, MPLADS utilization vs. Lok Sabha averages — admin-entered from public sources for MVP (Lok Sabha/PRS/MPLADS portal), each stat source-linked; quarterly refresh; session labeled.
**F2. Issue-Response Ledger (per authority, from design)**
- Auto-generated from Module E for the MP **and every routed authority** (Corporation, KSRTC, PCB, departments): representations sent/acknowledged/acted-on, median response time, per-item timeline. Authority pages are lightweight ledger views (no scorecard).
**F3. Sentiment Context — two streams**
- (a) Deliberation agreement distributions + trend (from Module C).
- (b) **Response-satisfaction ratings (new, from design):** after a representative/authority response is published, T2 constituents who supported or deliberated the issue may rate it "satisfactory / not satisfactory"; displayed as a monthly trend with per-month n and small-sample warnings.
- Both always carry sample-size caveat banners. **No composite score. No stars. No single number. No rankings.**
**F4. Right of Reply**
- Verified representative/authority account can attach a pinned response to any ledger entry.
- AC: Election-period mode flag (admin toggle): hides all F3 sentiment displays platform-wide; F1/F2 (public record) remain. Satisfaction prompts limited to issue participants (anti-brigading) and rate-limited.

### Module G — MP-Side Dashboard (desktop-optimized, merged from v1.1)

**G1. Representative Account & Office Seats**
- Office verification (manual: letterhead authorization); 1 representative identity + up to 3 staff seats with named audit trail ("Posted by office staff").
**G2. Issue Inbox**
- All Concerns + representations addressed to the representative, sorted by support/urgency; response-clock chips (days since delivery).
**G3. Response Composer & Showcase**
- Response types: Acknowledge / Position statement / Action taken (evidence upload) / Meeting requested / Decline with reasons. Published as **badged, pinned, top-of-thread showcase card** on the relevant issue/ledger entry; shareable link + auto-generated share image.
**G4. Office Analytics (from design)**
- Response rate, median response time, **response reach** ("N constituents saw your last response"), and sentiment-impact annotations (e.g., response date markers on satisfaction trend).
**G5. Model Bills Received Inbox (from design)**
- List of ratified/in-ratification bills addressed to the office, with quorum status and "acknowledgement due on receipt" tracking; acknowledgement action feeds tracker (K4).
- AC: Every office post updates ledger (F2) atomically; representative cannot edit citizen content or delete ledger history; responses editable ≤24h with public edit history; reach counts from privacy-respecting analytics only.

### Module K — Model Bills & Ratification (moved from v1.2 into v1)

**K1. Bill Drafting Workspace**
- Panel drafting group + legal volunteers compose from the Legislation-Track template: plain-language summary, chaptered full draft (accordion structure per design), evidence annex (attachments, RTI responses, consensus report, photo evidence sets).
- Drafts reference source deliberation + consensus percentages.
**K2. Publication & Bill Registry**
- Public bill page with ID (e.g., MB-2026-03), drafting attribution ("Drafted by the Steering Panel from the X deliberation"), publish date; constituency bill index.
**K3. Ratification Vote**
- T2-only vote: Support / Support with amendments / Oppose; amendment comments collected; max 2 amendment cycles.
- **Quorum: 20% of verified constituents** (per design; configurable); visible quorum progress bar; voting window with close date.
- AC: One vote per T2 user; results published with full counts; "support with amendments" triggers panel amendment review before transmission.
**K4. Transmission & Status Tracker**
- On ratification: transmitted per Module E mechanics to the MP (and marked authorities); tracker states: Delivered → Acknowledged → Raised in Parliament / PMB / Question → Closed.
- Standing disclaimer on every bill page (from design): "A model bill is a citizen draft — it has no legal force. It shows the MP a legislative path the constituency has already deliberated and ratified."
- AC: Tracker updates evidenced; bill status mirrored in ledger (F2) and MP inbox (G5).

### Module L — RTI Module (moved from v1.2 into v1)

**L1. Draft from Template**
- RTI drafts linked to an issue; authority picker (from authority registry); templates per category (maintenance records, contracts/payments, inspection reports…), **reviewed by the Steering Panel**; free editing with guidance ("specific and time-bound").
**L2. Filing Crowdfund**
- Target = fee + postage + **first-appeal reserve**; fixed micro-contribution (₹10 default) via UPI; contributor count public, contributor identities pseudonymous; refund/rollover policy if target unmet in 14 days.
**L3. Filing & Deadline Tracker**
- Filed by a **designated consenting volunteer, never in the requester's name** (standing policy, stated in UI); RTI reference number logged; Day-N-of-30 statutory tracker; **auto-drafted first appeal** generated if no reply by statutory deadline (volunteer reviews & files).
**L4. Response Publication & Evidence Loop**
- Responses published in full (PII-redaction pass by moderator) into the linked issue thread and citable in bill evidence annexes; searchable RTI response repository per constituency.
- AC: Every filed RTI shows live status; appeals tracked (first appeal → SIC); crowdfund ledger public; payments via **Razorpay UPI** (server-side orders + webhooks per HLD), PCI scope with aggregator, no instrument storage.

### Module H — Moderation & Trust

- Report flow on all UGC; moderation queue with policy checklist; actions: approve / edit-redact (PII) / remove / warn / suspend.
- **Public moderation log** (redacted): action, category, rule cited, date.
- Anti-brigading v1: velocity anomaly alerts on supports/votes (flag-for-review, never auto-delete), device/IP heuristics, T2-weighting already structural.
- AC: Grievance Officer contact + IT Rules 2021 grievance flow pages live at launch; takedown SLA workflow documented.

### Module I — Civic Literacy Layer (embedded)

- Router explainer cards (B2) with legal-basis citations and the three-column "Who does what" visual (Councillor / MLA / MP) per design; contextual micro-explainers (what an MP can do, MPLADS, how representations work, what a model bill is) as dismissible info cards; 8–10 explainer pages at launch, bilingual.
- **Public landing counters (from design):** verified constituents, issues acted upon, bills transmitted — live, sourced from the event log.

### Module J — Notifications & Comms

- Channels: in-app + email (SES/Resend, ap-south-1 preferred) for MVP; SMS (MSG91) only for OTP and critical status changes (cost-controlled, spend alarm); WhatsApp deferred.
- **Hard dependency: TRAI DLT registration** (sender ID + templates) must be filed at project start — multi-week lead time; OTP delivery in India fails without it (HLD amendment A4).
- Events: issue promoted, deliberation opened/closing (48h reminder), representation status change, panel draw results, MP response on followed issue.

---

## 4. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Localization** | Full bilingual UI (Malayalam primary / English); all UGC language-free-form; Malayalam font rendering QA on low-end Android browsers |
| **Performance** | Mobile-first; TTI < 4s on 4G mid-range Android; images lazy/compressed; target Lighthouse ≥ 85 mobile |
| **Availability** | 99.5% MVP target; graceful read-only degradation |
| **Security** | OWASP ASVS L2; identity vault isolation (A4); encryption at rest + TLS; secrets management; pen test before public launch; **CERT-In compliance: ≥180-day log retention, NTP time-sync, 6-hour incident reporting readiness** (Security Design §7, §9) |
| **Privacy/DPDP** | Consent records, purpose notices at each capture point, erasure & data-export flows, retention schedule (raw KYC ≤24h), DPO named |
| **Accessibility** | WCAG 2.1 AA; status = icon+label (never color alone); screen-reader pass on core flows |
| **Auditability** | Append-only event log for: ledger changes, moderation actions, panel actions, sortition draws, transmissions |
| **Data residency** | All data in India-region cloud |
| **Analytics** | Cloudflare Web Analytics (cookieless) for web metrics; **product funnels (verification, deliberation, loops) derived from the platform's own append-only event log** — no third-party product-analytics tool, no ad trackers, ever (HLD amendment A8) |

---

## 5. Technical Architecture (superseded — see HLD v1.0, summarized)

This section's v1.0/v1.1 assumptions (Next.js, NestJS, Redis, PostHog) are **superseded by the Technical Architecture Document (HLD) v1.0**, which is authoritative. Summary of the confirmed architecture:

- **Frontend/backend:** Astro 6 on Cloudflare Workers (islands = React 19; mutations via Astro API endpoints); Hono Worker for the public open-data API; Cron Worker (`apps/jobs`) for clustering, response clocks, and RTI deadlines.
- **Data:** Supabase Postgres (Mumbai) via Hyperdrive/Supavisor; Drizzle; RLS everywhere; **separate identity-vault deployment** (second project + India-pinned vault-svc) per HLD §4; R2 for documents; KV for config/flags (incl. election mode).
- **Auth:** Supabase Auth phone OTP (MSG91, DLT-registered) primary; email magic link fallback; no Google OAuth in MVP.
- **Deliberation math:** TypeScript PCA/2-means in the cron Worker (validated at M0 against Pol.is reference); fallback = plain agreement %.
- **Delivery:** GitHub public monorepo; CI on GitHub Actions; Workers Builds previews/staging/prod; process per the Dev Process Playbook (CLAUDE.md invariants, subagents, hooks, maintainer-gated AI in CI).
- Multi-constituency-ready data model (constituency_id everywhere) even though the pilot runs one.

---

## 6. Release Plan & Milestones

| Milestone | Content | Target |
|---|---|---|
| **M0 — Spikes (2 wks)** | The 7 spikes per HLD §10 — incl. **DLT registration filed on day 1**, vault-svc runtime decision, clustering PoC, Razorpay round trip, Hyperdrive smoke test, draw determinism | Wk 2 |
| **M1 — Alpha (internal)** | Modules A, B, H core; seed content | Wk 8 |
| **M2 — Closed Beta (500 users)** | + C (deliberation), F1/F3, I, J; invite via partner orgs | Wk 14 |
| **M3 — Panel & Transmission** | + D (incl. verify-the-draw page), E multi-authority, F2 per-authority; first sortition draw; first representation | Wk 18 |
| **M4 — MP Dashboard live** | + G (incl. G5 bills inbox); onboard ≥1 representative office (concierge) | Wk 20 |
| **M5 — RTI Module live** | + L end-to-end (draft → crowdfund → file → track → publish); first RTI filed | Wk 24 |
| **M6 — Model Bills live** | + K end-to-end; first bill drafted from a completed deliberation enters ratification | Wk 27 |
| **M7 — Public Launch** | Pen test done, legal sign-off (§10 strategy doc + payment & RTI counsel review), moderation staffing live | Wk 28–30 |

> Timeline impact of merging K + L into v1: **+6 weeks** vs. PRD v1.0 (24 → 30 wks). If launch date is fixed, the alternative is a public launch at M5 with Model Bills following as the first post-launch release — flagged as a decision, not assumed.

---

## 7. Risks & Dependencies (delivery-level)

1. **Aadhaar XML UX friction** — offline e-KYC download is clunky for low-literacy users → mitigation: step-by-step Malayalam video guide + assisted verification desks at physical drives; DigiLocker path if partner access lands.
2. **EPIC manual review load** — bounded by reviewer staffing → mitigation: OCR assist, batch drives, 72h SLA monitoring.
3. **Pol.is spike failure** — fallback defined (C-module decision) — do not let clustering block M2.
4. **MP office onboarding slips** — G is in v1, but M5 launch does **not** gate on a live MP account; ledger works from public record + transmissions alone.
5. **SMS cost creep** — email-first policy; SMS budget cap alarm.
6. **Legal sign-off latency** — engage counsel at M1, not M4; add payment (crowdfund) and RTI-process counsel review.
7. **Crowdfund/payment compliance** — UPI aggregator onboarding and refund handling add regulatory surface → start aggregator KYC at M0; keep contributions micro and capped.
8. **Bill ratification turnout risk** — 20% quorum of verified constituents is ambitious → quorum configurable; panel may not open ratification until deliberation participation suggests quorum is reachable.
9. **Real-representative data in design assets** — mockups currently use the sitting MP's real name/data → replace with fictional placeholder before any external sharing.
10. **DLT registration delay** — OTP (and thus all registration) is blocked without approved sender ID + templates → file at M0 day 1; keep email magic-link fallback functional as the contingency signup path.

---

## 8. Open Product Decisions (resolve by M1)

1. Pseudonym policy details: ward display is now standard on contributions per design — confirm privacy comfort
2. Concern threshold (100), deliberation quorums, and **bill ratification quorum (design: 20% of verified constituents)** — confirm with pilot partners
3. Whether MLA offices get G-module accounts in pilot (recommended: yes — most Resolution-Track items route to MLA/local bodies)
4. Moderation staffing: 2 paid part-time + volunteer bench vs. fully staffed
5. Election-period mode trigger ownership (admin manual vs. calendar-driven)
6. **Panel term: 6 months (design) vs. 90 days (PRD v1.0)** — v1.1 adopts 6 months; confirm
7. **Launch gate: full M7 (bills live) vs. launch at M5 with bills as first post-launch release**
8. Brand: "Praja / പ്രജ" trademark and domain availability check

## 9. Design Package Audit — Gaps to Cover in Design Sprint 2

Screens designed and accepted: landing, 3-step verification, constituency dashboard (+ Malayalam variant), issue detail + deliberation, accountability ledger (3-layer), model bill, steering panel, MP office console, RTI module, responsibility-router explainer, design-system sheet.

Not yet designed (required before corresponding build milestones):
1. Raise-an-issue form (B1) and issues list/browse page — needed by M1
2. Public moderation log + report/grievance flow pages (H, IT Rules) — needed by M2
3. Notifications center + email templates (J) — M2
4. Profile & settings: pseudonym management, language, data export/erasure (A, DPDP) — M2
5. Duplicate-suggestion / merge UI (B3) — M1
6. Statement submission + moderation-state UI (C1) — M2
7. Election-period mode states (sentiment hidden banners) — M4
8. Volunteer-pool opt-in form detail + draw acceptance flow (D) — M3
9. Admin console (routing rules, transmissions, scorecard entry, draws, election toggle) — M1–M3, internal styling acceptable
10. Empty states, error states, and low-bandwidth/offline banners across all screens — M2
11. Amendment-cycle UI for "Support with amendments" outcomes (K3) — M6

---

*End PRD v1.1 (design-audit revision). Changes from v1.0: Modules K (Model Bills) and L (RTI) moved into v1; multi-authority routing/ledgers; response-satisfaction sentiment stream; panel term 6 months with roles, party-office bar, and verify-the-draw page; MP console reach analytics + bills inbox; timeline +6 weeks. Next artifacts: Technical Architecture (HLD) with identity-vault design, and Data Protection & Security Design.*
