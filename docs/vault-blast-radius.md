# Identity Vault — breach blast-radius analysis

Required by PRD A4 and HLD §4.4. Companion to
[`data-protection-security-design.md`](./data-protection-security-design.md),
which holds the full threat model; this document answers one narrower question:

> **For each thing an attacker could actually get, what does it let them learn
> about a real person?**

Written against the schema as it exists, not as designed. Where the design
promise is not yet met, that is stated in
[Known weakenings](#known-weakenings) rather than omitted — an aspirational
blast-radius document is worse than none, because it invites reliance on a
guarantee that is not there.

Last reviewed: 2026-07-27 (issue #23).

---

## 1. What each database actually holds

**Participation DB** (`packages/db`, schema `public`) — knows a person only as
a `member_id`:

`members` carries `member_id`, `pseudonym`, `tier`, `constituency_id`,
`ward_id`, `locale`, `assembly_segment`, `created_at`. No name, no email, no
phone, no EPIC or Aadhaar anything. Everything else — issues, support,
statements, votes, the event log — hangs off `member_id`.

**Identity vault** (`packages/vault-db`, schema `vault`) — three tables:

| Table | Holds | Form |
|---|---|---|
| `auth_credentials` | email | HMAC hash **and** AES-GCM ciphertext |
| | magic-link token | SHA-256 hash |
| | pseudonym, locale | plaintext |
| | `linked` | boolean — **deliberately not a member_id** |
| `epic_verifications` | `member_id` | plaintext |
| | EPIC number | HMAC hash + AES-GCM ciphertext (ciphertext NULLed on review decision) |
| | uploaded ID document | AES-GCM ciphertext (NULLed on review decision) |
| | claimed assembly segment, status, reviewer note | plaintext |
| `access_log` | which vault operation, when, which gate, which vault row (`subject_ref`), how many rows | plaintext; append-only |

Three separate secrets protect this, none reused: `EMAIL_HASH_PEPPER` /
`EMAIL_ENCRYPTION_KEY` for email, `EPIC_HASH_PEPPER` /
`EPIC_ENCRYPTION_KEY` for EPIC numbers, `EPIC_DOC_ENCRYPTION_KEY` for
documents. All are Wrangler secrets — they live in neither database.

### The single link

**`epic_verifications.member_id` is the only vault→participation link in the
entire system.** `auth_credentials` stores a bare `linked` boolean precisely so
the vault cannot answer "which member does this email belong to". This is the
load-bearing fact of the whole architecture, and the reason a new
member_id-bearing vault table is a decision rather than a detail.

Consequence: **a T0 member has no vault→participation link at all.** Only
members who submitted an EPIC verification (T2) can be linked, and only through
that one column.

---

## 2. Blast radius per breach

### Participation DB alone

Attacker gets: the full public civic record plus the private parts —
who supported which issue, every statement and its author, every vote, the
event log — all keyed to pseudonymous `member_id`s and user-chosen pseudonyms.

Attacker does **not** get: any name, email, phone, EPIC number, Aadhaar
reference, or uploaded document. None of those exist in this database.

Residual risk is **self-identification, not decryption**: a user-chosen
pseudonym may itself name the person, and a narrow enough
ward + category + timing pattern can single someone out. This is the real
weakness of this half, and it is not a cryptographic one.

### Vault DB alone

Attacker gets: email ciphertexts and hashes, EPIC hashes, remaining document
ciphertexts, pseudonyms, claimed assembly segments, and the `member_id`s of
members who submitted an EPIC verification.

Attacker does **not** get: any civic activity. No issue, support, statement,
vote or deliberation record exists anywhere in the vault schema — enforced by
CLAUDE.md invariant 1 and, for the new `access_log`, asserted structurally in
`packages/vault-db/src/access-log.test.ts`.

Crucially, ciphertexts without `EMAIL_ENCRYPTION_KEY` / `EPIC_ENCRYPTION_KEY`
are not readable, and hashes without the matching pepper cannot be brute-forced
by guessing candidate emails or EPIC numbers — which is exactly what an
unpeppered hash of a low-entropy identifier like an EPIC number would permit.

So a vault breach alone yields: *these pseudonyms exist, these member_ids
submitted a voter ID, here is an opaque blob per person.* It does not say what
any of them did.

### Both databases, no secrets

Now `epic_verifications.member_id` joins. The attacker can say "this pseudonym
did these civic things" — but they could already infer much of that from the
participation DB, since the pseudonym is in both. What they still cannot do is
attach a **real-world identity**: emails and EPIC numbers remain ciphertext,
hashes remain unpeppered-guess-proof.

### Both databases **plus** the peppers/keys

This is the full compromise, and the only combination that deanonymises
participation. With `EMAIL_HASH_PEPPER` an attacker can confirm whether a
*suspected* email is registered; with `EMAIL_ENCRYPTION_KEY` they can decrypt
emails outright; with `EPIC_HASH_PEPPER` they can confirm a suspected voter ID
and, via `member_id`, tie it to that person's complete civic record.

**Requiring three separate compromises — participation DB, vault DB, and
Wrangler secrets — is the design.** The secrets are the component least likely
to fall with either database, which is why they are the ones held furthest
away.

---

## 3. What each threat actor gets

Actors as named in `data-protection-security-design.md`.

**State-adjacent actor** — legal compulsion or sophisticated intrusion, aiming
to unmask a critic. Compelling the participation DB produces pseudonymous
records. Compelling the vault produces identity records with no civic activity
attached, and for T0 members not even a `member_id`. Unmasking a *specific*
critic requires compelling both plus the secrets, and the vault genuinely
cannot answer "who wrote statement X" — no query exists, in any database, that
returns that. Not by policy: by schema.

**SLAPP litigant** — discovery against one statement's author. Same structural
answer, and it is the strongest available response: the data to comply does not
exist in a single place. See the disclosure runbook in the security-design doc.

**Insider or compromised admin** — the actor with legitimate access, and the one
this issue (#23) actually improves. Every vault read now appends to
`vault.access_log`, which is append-only at the grant level:
`vault_role` — the role vault-svc performs reads as — holds `SELECT, INSERT`
only, with `UPDATE`, `DELETE` **and `TRUNCATE`** explicitly revoked
(migration 0002; TRUNCATE is a separate privilege that RLS does not govern, so
revoking DELETE alone would still leave a way to wipe the trail wholesale). An insider
who reads the vault therefore cannot erase the evidence that they did.
`GET /review/epic/queue` is the read worth watching, because a single call
decrypts every pending row's EPIC number *and* uploaded document; the log
records a `row_count` per call, and any call above
`VAULT_ACCESS_ALERT_ROW_THRESHOLD` also emits a structured
`vault_bulk_access` warn line.

---

## 4. Erasure model (DPDP)

Recorded here because it follows directly from the analysis above, and because
the implementation (issue #23 part 2) should be built against a written
rationale rather than invent one.

**Erasure destroys the vault records, not the participation record.**

`event_log` and `moderation_actions` are append-only with `UPDATE`/`DELETE`
revoked at the database level (participation migration 0000), so erasure
*cannot* null out `event_log.actor_member_id`. It does not need to. Once
`auth_credentials` and `epic_verifications` rows are gone, a `member_id` is a
dangling pseudonymous token with nothing anywhere that resolves it to a person.
**Destroying the re-identification key is the erasure** — which is only true
because of the separation this document describes.

Alongside that, `members.pseudonym` is rotated to a non-identifying value,
because a user-chosen pseudonym may itself name the person. That single change
also turns the one place a pseudonym is shown to others — the supporter list on
the issue detail page — into an unattributed entry, satisfying "published
contributions are anonymised, attributed to a former member, never deleted".

**`statement_votes` are kept.** They are private rows, but they feed *published*
consensus percentages and a frozen PDF artifact. Deleting them would
retroactively change an already-published public record — falsifying the civic
record to honour a deletion. Post-erasure they are anonymous rows whose
`member_id` resolves to nobody, which is the correct end state.

What this does **not** cover, and must be handled manually until automated
(the issue's own out-of-scope note): downstream caches, the frozen consensus
PDFs already written to R2, and any export taken before the erasure.

---

## 5. Known weakenings

Stated plainly. Each is real today.

1. **The two databases are one physical Postgres in dev and in CI.**
   `.env.example` points `DATABASE_URL` and `VAULT_DATABASE_URL` at the same
   container, separated by schema (`public` vs `vault`) and role, not by
   deployment. "Two projects, two credential sets" (HLD §4.1) is **not true
   anywhere yet** — that is issue **#19**. Until it lands, "both databases"
   in section 2 is a single breach, not two.
2. **Dual-control key splitting is not implemented.** HLD §4.1 specifies the
   vault service-role key split half-in-Wrangler-secret, half-released at
   deploy, so no single admin can read the vault from a laptop. Today a single
   `VAULT_SVC_DATABASE_URL` secret is sufficient. Also #19.
3. **`apps/vault-svc` serves `/internal/*` and `/review/*` on the same public
   hostname as `/public/epic/submit`.** The public origin is required — the
   browser posts the raw EPIC number straight to the vault so it never transits
   `apps/web` (HLD §4.3) — but the internal and reviewer routes are exposed on
   that same hostname, guarded by bearer token (and, for review, an IP
   allowlist). Narrowing needs a custom domain plus per-environment `routes`;
   recorded in [`deploy.md`](./deploy.md) from issue #18.
4. **Alerting has no delivery channel.** The access log is written and the
   bulk-read warn line is emitted with observability enabled, so
   `wrangler tail` and Workers Analytics can see it — but nothing pages a
   founder. Wiring a real channel is outstanding, as is the CERT-In 180-day
   retention requirement for this log (#66).
5. **The access log outlives an erasure.** It records vault row ids and, for
   member-scoped reads, `member_id` — and it is append-only, so an erasure
   cannot remove those. This is deliberate: an audit log a data-subject request
   can delete is not an audit log, and CERT-In requires retention. The residual
   trace is a `member_id` with no identity behind it, consistent with the
   erasure model above.
6. **Self-identification is unmitigated.** No amount of separation prevents
   someone choosing a pseudonym that names them, or writing an identifying
   statement. The registration flow's pseudonym filter blocks profanity and
   party names, not self-identification.

---

## 6. Review cadence

The security-design doc schedules a quarterly internal audit including a
"vault access log review". Now that the log exists, that review has something
to read. Suggested checks:

- Any `epic.review_queue` row with an unexpectedly high `row_count`.
- Reads with `caller = 'review'` outside a reviewer's working pattern.
- `outcome = 'not_found'` clusters on `registration.start.duplicate_check`,
  which would indicate someone probing whether particular emails are
  registered.
