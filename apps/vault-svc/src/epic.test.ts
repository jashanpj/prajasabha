import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createVaultDbClient } from "vault-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "./env";
import app from "./index";

// Issue #22 (A3 — T2 verification: EPIC/Voter ID -> constituency mapping).
// Exercises the three route groups epic.ts mounts into index.ts's shared
// Hono app: a public submission endpoint (Turnstile-gated, no
// internal-service auth), the internal link/status endpoints
// (requireInternalToken, same posture as index.ts's /internal/registrations
// routes), and a human-reviewer queue (requireReviewAccess — a completely
// separate two-factor gate, see review-auth.test.ts).
//
// `vault.epic_verifications` does not exist yet (no migration has landed),
// so every request below is expected to fail red — either epic.ts's routes
// 404 against index.ts's current app, or (once routes exist but before the
// table does) the underlying DB call throws "relation ... does not exist".
// Both are the correct red-phase failure mode: this file asserts against
// the endpoint *contract*, not the current code.

const INTERNAL_TOKEN = "test-internal-token";
const REVIEW_TOKEN = "test-review-queue-token";
const REVIEW_IP = "203.0.113.77";

interface EpicBindings extends Bindings {
  TURNSTILE_SECRET_KEY: string;
  REVIEW_QUEUE_TOKEN: string;
  REVIEW_QUEUE_IP_ALLOWLIST: string;
  EPIC_HASH_PEPPER: string;
  EPIC_ENCRYPTION_KEY: string;
  EPIC_DOC_ENCRYPTION_KEY: string;
  EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: string;
  VAULT_ACCESS_ALERT_ROW_THRESHOLD: string;
}

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

function testEnv(overrides: Partial<EpicBindings> = {}): EpicBindings {
  const vaultSvcDatabaseUrl = process.env.VAULT_SVC_DATABASE_URL;
  if (!vaultSvcDatabaseUrl) {
    throw new Error(
      "VAULT_SVC_DATABASE_URL is not set. apps/vault-svc tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  return {
    VAULT_SVC_DATABASE_URL: vaultSvcDatabaseUrl,
    // Same test-only, obviously-fake 32-byte keys as index.test.ts.
    EMAIL_ENCRYPTION_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
    EMAIL_HASH_PEPPER: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
    // Distinct, EPIC-scoped secrets (issue #16/#22) — never reused from the
    // email keys above, per crypto.ts's key-separation posture.
    EPIC_HASH_PEPPER: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    EPIC_ENCRYPTION_KEY: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
    EPIC_DOC_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    VAULT_SVC_INTERNAL_TOKEN: INTERNAL_TOKEN,
    MAGIC_LINK_TTL_MINUTES: "15",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    REVIEW_QUEUE_TOKEN: REVIEW_TOKEN,
    REVIEW_QUEUE_IP_ALLOWLIST: REVIEW_IP,
    RATE_LIMIT_KV: fakeKv(),
    EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "1000",
    // Issue #23 — every logged vault read loads this threshold, so it must
    // be present or loadVaultAccessAlertConfig throws. High by default so
    // existing tests do not incidentally trip the bulk-access warn line;
    // access-log.test.ts overrides it to assert the alert fires.
    VAULT_ACCESS_ALERT_ROW_THRESHOLD: "1000",
    ...overrides,
  };
}

function authHeaders(token: string = INTERNAL_TOKEN) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function reviewHeaders(token: string = REVIEW_TOKEN, ip: string = REVIEW_IP) {
  return {
    Authorization: `Bearer ${token}`,
    "CF-Connecting-IP": ip,
    "Content-Type": "application/json",
  };
}

function hostnameIs(input: RequestInfo | URL, hostname: string): boolean {
  try {
    return new URL(String(input)).hostname === hostname;
  } catch {
    return false;
  }
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (hostnameIs(input, "challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`Unexpected fetch call to ${String(input)}`);
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

// --- Direct-SQL test helpers -------------------------------------------
// Bypass the HTTP layer entirely for setup/assertions that need to reach
// past what the endpoints themselves expose (e.g. back-dating a row's
// createdAt, or staging an "already approved" row) — same posture as
// packages/vault-db's own rls.test.ts/uniqueness.test.ts, just reusing the
// already-available vault-db client instead of a raw `pg.Client` (not a
// direct dependency of apps/vault-svc).

interface EpicVerificationRow {
  [key: string]: unknown;
  id: string;
  member_id: string | null;
  status: string;
  epic_number_hash: string;
  epic_number_ciphertext: string | null;
  epic_number_iv: string | null;
  doc_ciphertext: string | null;
  doc_iv: string | null;
  assembly_segment_claimed: string;
  reviewed_at: string | null;
  created_at: string;
}

async function fetchRow(env: EpicBindings, id: string): Promise<EpicVerificationRow | undefined> {
  const db = createVaultDbClient(env.VAULT_SVC_DATABASE_URL);
  const result = await db.execute<EpicVerificationRow>(
    sql`SELECT * FROM vault.epic_verifications WHERE verification_id = ${id}`,
  );
  return result.rows[0];
}

/** Directly stages a pre-existing "approved, linked to some other member" row for the duplicate-hash test. */
async function markApproved(env: EpicBindings, id: string, memberId: string): Promise<void> {
  const db = createVaultDbClient(env.VAULT_SVC_DATABASE_URL);
  await db.execute(
    sql`UPDATE vault.epic_verifications
        SET status = 'approved', member_id = ${memberId}, reviewed_at = now()
        WHERE verification_id = ${id}`,
  );
}

/** Back-dates a row's createdAt so the SLA-overdue queue flag can be tested deterministically. */
async function backdateCreatedAt(env: EpicBindings, id: string, hoursAgo: number): Promise<void> {
  const db = createVaultDbClient(env.VAULT_SVC_DATABASE_URL);
  await db.execute(
    sql`UPDATE vault.epic_verifications
        SET created_at = now() - make_interval(hours => ${hoursAgo})
        WHERE verification_id = ${id}`,
  );
}

// --- HTTP test helpers ---------------------------------------------------

interface SubmitBody {
  epicNumber: string;
  docBase64: string;
  assemblySegmentClaimed: string;
  turnstileToken: string;
}

function submitEpic(env: EpicBindings, overrides: Partial<SubmitBody> = {}) {
  const body: SubmitBody = {
    epicNumber: `ABC${randomUUID().slice(0, 8).toUpperCase()}`,
    docBase64: "ZmFrZS1kb2N1bWVudA==",
    assemblySegmentClaimed: "Test Assembly Segment",
    turnstileToken: "valid-turnstile-token",
    ...overrides,
  };
  return app.request(
    "/public/epic/submit",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

function linkEpic(env: EpicBindings, memberId: string, docRef: string) {
  return app.request(
    "/internal/epic/link",
    { method: "POST", headers: authHeaders(), body: JSON.stringify({ memberId, docRef }) },
    env,
  );
}

function statusFor(env: EpicBindings, memberId: string) {
  return app.request(`/internal/epic/status?memberId=${memberId}`, { headers: authHeaders() }, env);
}

/** Submits a fresh doc and immediately links it to a (new, random) member — the common precondition for link/status/review tests. */
async function submitAndLink(
  env: EpicBindings,
  memberId: string = randomUUID(),
  submitOverrides: Partial<SubmitBody> = {},
): Promise<{ docRef: string; memberId: string }> {
  const submitRes = await submitEpic(env, submitOverrides);
  const { docRef } = (await submitRes.json()) as { docRef: string };
  await linkEpic(env, memberId, docRef);
  return { docRef, memberId };
}

// --- POST /public/epic/submit --------------------------------------------

describe("POST /public/epic/submit", () => {
  it("accepts a valid submission and stores an orphaned pending row, returning its docRef", async () => {
    const env = testEnv();
    const res = await submitEpic(env);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { docRef: string };
    expect(body.docRef).toBeTruthy();

    const row = await fetchRow(env, body.docRef);
    expect(row).toBeDefined();
    expect(row?.member_id).toBeNull();
    expect(row?.status).toBe("pending");
  });

  it("rejects a submission once the per-IP rate limit is exceeded", async () => {
    const env = testEnv({ EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "1" });
    const first = await submitEpic(env);
    expect(first.status).toBe(202);

    const second = await submitEpic(env);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
  });

  it("rejects a submission with an invalid Turnstile token — no row is auth-bypassed into existence", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (hostnameIs(input, "challenges.cloudflare.com")) {
        return new Response(JSON.stringify({ success: false }), { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${String(input)}`);
    }) as typeof fetch;

    const res = await submitEpic(testEnv());
    expect(res.status).toBe(403);
  });
});

// --- POST /internal/epic/link --------------------------------------------

describe("POST /internal/epic/link", () => {
  it("rejects a request with no internal bearer token", async () => {
    const res = await app.request(
      "/internal/epic/link",
      { method: "POST", body: JSON.stringify({}) },
      testEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong internal token", async () => {
    const res = await app.request(
      "/internal/epic/link",
      { method: "POST", headers: authHeaders("wrong-token"), body: JSON.stringify({}) },
      testEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("sets memberId on the orphaned row and returns 200 pending", async () => {
    const env = testEnv();
    const submitRes = await submitEpic(env);
    const { docRef } = (await submitRes.json()) as { docRef: string };
    const memberId = randomUUID();

    const res = await linkEpic(env, memberId, docRef);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verificationId: docRef, status: "pending" });

    const row = await fetchRow(env, docRef);
    expect(row?.member_id).toBe(memberId);
  });

  it("returns 404 unknown_doc_ref for a docRef that was never submitted", async () => {
    const res = await linkEpic(testEnv(), randomUUID(), randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_doc_ref" });
  });

  it("returns 409 duplicate_epic when an approved row already exists for the same EPIC number, leaving the new row orphaned", async () => {
    const env = testEnv();
    const epicNumber = `DUP${randomUUID().slice(0, 8).toUpperCase()}`;

    // Stage the "already verified by someone else" precondition directly
    // (the review-approval endpoints are exercised separately below —
    // this test only needs an approved row with a matching hash to exist).
    const firstSubmit = await submitEpic(env, { epicNumber });
    const { docRef: firstDocRef } = (await firstSubmit.json()) as { docRef: string };
    await markApproved(env, firstDocRef, randomUUID());

    const secondSubmit = await submitEpic(env, { epicNumber });
    const { docRef: secondDocRef } = (await secondSubmit.json()) as { docRef: string };
    const newMemberId = randomUUID();

    const res = await linkEpic(env, newMemberId, secondDocRef);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_epic" });

    const orphanRow = await fetchRow(env, secondDocRef);
    expect(orphanRow?.member_id).toBeNull();
  });
});

// --- GET /internal/epic/status -------------------------------------------

describe("GET /internal/epic/status", () => {
  it("rejects a request with no internal bearer token", async () => {
    const res = await app.request(`/internal/epic/status?memberId=${randomUUID()}`, {}, testEnv());
    expect(res.status).toBe(401);
  });

  it("returns the latest verification's status/segment/reviewedAt, with no decrypted PII", async () => {
    const env = testEnv();
    const memberId = randomUUID();
    await submitAndLink(env, memberId, { assemblySegmentClaimed: "Alpha Segment" });

    const res = await statusFor(env, memberId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "pending",
      assemblySegmentClaimed: "Alpha Segment",
      reviewedAt: null,
    });
    expect(body).not.toHaveProperty("epicNumber");
    expect(body).not.toHaveProperty("docBase64");
  });

  it("returns 404 not_found when the member has no verification row at all", async () => {
    const res = await statusFor(testEnv(), randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

// --- /review/epic/* authz (requireReviewAccess, not requireInternalToken) -

describe("/review/epic/* requires requireReviewAccess, independently of requireInternalToken", () => {
  it("rejects a queue request with no auth headers at all", async () => {
    const res = await app.request("/review/epic/queue", {}, testEnv());
    expect(res.status).toBe(401);
  });

  it("rejects a queue request bearing the internal-service token instead of the review-queue token", async () => {
    const res = await app.request("/review/epic/queue", { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(401);
  });

  it("rejects an approve request with no auth headers at all", async () => {
    const env = testEnv();
    const { docRef } = await submitAndLink(env);
    const res = await app.request(
      `/review/epic/${docRef}/approve`,
      { method: "POST", body: JSON.stringify({ assemblySegmentConfirmed: "x" }) },
      env,
    );
    expect(res.status).toBe(401);
  });
});

// --- GET /review/epic/queue -----------------------------------------------

describe("GET /review/epic/queue", () => {
  it("lists only linked+pending rows and correctly flags overdueBySla", async () => {
    const env = testEnv();

    const fresh = await submitAndLink(env, randomUUID(), {
      assemblySegmentClaimed: "Fresh Segment",
    });
    const overdue = await submitAndLink(env, randomUUID(), {
      assemblySegmentClaimed: "Overdue Segment",
    });
    await backdateCreatedAt(env, overdue.docRef, 96); // > 72h SLA

    const unlinkedSubmit = await submitEpic(env);
    const { docRef: unlinkedDocRef } = (await unlinkedSubmit.json()) as { docRef: string };

    const approved = await submitAndLink(env, randomUUID(), {
      assemblySegmentClaimed: "Already Approved Segment",
    });
    await markApproved(env, approved.docRef, approved.memberId);

    const res = await app.request("/review/epic/queue", { headers: reviewHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      assemblySegmentClaimed: string;
      overdueBySla: boolean;
    }>;
    const byId = new Map(body.map((row) => [row.id, row]));

    expect(byId.has(fresh.docRef)).toBe(true);
    expect(byId.get(fresh.docRef)?.overdueBySla).toBe(false);

    expect(byId.has(overdue.docRef)).toBe(true);
    expect(byId.get(overdue.docRef)?.overdueBySla).toBe(true);

    // Never-linked (still memberId IS NULL) and already-approved rows must
    // not appear in a *pending* reviewer's queue.
    expect(byId.has(unlinkedDocRef)).toBe(false);
    expect(byId.has(approved.docRef)).toBe(false);
  });
});

// --- POST /review/epic/:id/approve ---------------------------------------

describe("POST /review/epic/:id/approve", () => {
  it("approves the row, nulls the ciphertext columns (data minimization), and stamps reviewedAt", async () => {
    const env = testEnv();
    const { docRef } = await submitAndLink(env);

    const res = await app.request(
      `/review/epic/${docRef}/approve`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ assemblySegmentConfirmed: "Confirmed Segment" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const row = await fetchRow(env, docRef);
    expect(row?.status).toBe("approved");
    expect(row?.reviewed_at).toBeTruthy();
    expect(row?.epic_number_ciphertext).toBeNull();
    expect(row?.epic_number_iv).toBeNull();
    expect(row?.doc_ciphertext).toBeNull();
    expect(row?.doc_iv).toBeNull();
  });

  it("rejects a second approve on an already-decided row instead of silently re-transitioning it", async () => {
    const env = testEnv();
    const { docRef } = await submitAndLink(env);

    const first = await app.request(
      `/review/epic/${docRef}/approve`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ assemblySegmentConfirmed: "First Decision" }),
      },
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      `/review/epic/${docRef}/approve`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ assemblySegmentConfirmed: "Second Decision" }),
      },
      env,
    );
    expect(second.status).toBe(409);

    const row = await fetchRow(env, docRef);
    expect(row?.assembly_segment_claimed).toBe("First Decision");
  });
});

// --- POST /review/epic/:id/reject ----------------------------------------

describe("POST /review/epic/:id/reject", () => {
  it("rejects the row, nulls the ciphertext columns, and stamps reviewedAt", async () => {
    const env = testEnv();
    const { docRef } = await submitAndLink(env);

    const res = await app.request(
      `/review/epic/${docRef}/reject`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ reviewerNote: "Photo illegible" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const row = await fetchRow(env, docRef);
    expect(row?.status).toBe("rejected");
    expect(row?.reviewed_at).toBeTruthy();
    expect(row?.epic_number_ciphertext).toBeNull();
    expect(row?.doc_ciphertext).toBeNull();
  });

  it("rejects a reject call on an already-approved row instead of silently re-transitioning it", async () => {
    const env = testEnv();
    const { docRef } = await submitAndLink(env);

    const approve = await app.request(
      `/review/epic/${docRef}/approve`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ assemblySegmentConfirmed: "Approved Segment" }),
      },
      env,
    );
    expect(approve.status).toBe(200);

    const reject = await app.request(
      `/review/epic/${docRef}/reject`,
      {
        method: "POST",
        headers: reviewHeaders(),
        body: JSON.stringify({ reviewerNote: "Too late" }),
      },
      env,
    );
    expect(reject.status).toBe(409);

    const row = await fetchRow(env, docRef);
    expect(row?.status).toBe("approved");
  });
});
