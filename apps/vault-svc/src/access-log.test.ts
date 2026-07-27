import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createVaultDbClient } from "vault-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_ACCESS_OPERATIONS } from "./access-log";
import type { Bindings } from "./env";
import app from "./index";

// Issue #23 (A4) — vault access logging. HLD §4.1: "All vault reads append to
// an access log alerting to founders." Before this, nothing in the vault was
// logged at all.
//
// These assert the audit trail through the real HTTP surface rather than by
// unit-testing the helper, because the property that matters is "you cannot
// read identity data out of this service without leaving a record" — which is
// a claim about the endpoints, not about a function.
//
// Same conventions as epic.test.ts: real Postgres via testEnv(),
// app.request(), and direct SQL for assertions the endpoints don't expose.

const INTERNAL_TOKEN = "test-internal-token";
const REVIEW_TOKEN = "test-review-queue-token";
const REVIEW_IP = "203.0.113.77";

interface TestBindings extends Bindings {
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

function testEnv(overrides: Partial<TestBindings> = {}): TestBindings {
  const vaultSvcDatabaseUrl = process.env.VAULT_SVC_DATABASE_URL;
  if (!vaultSvcDatabaseUrl) {
    throw new Error(
      "VAULT_SVC_DATABASE_URL is not set. apps/vault-svc tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  return {
    VAULT_SVC_DATABASE_URL: vaultSvcDatabaseUrl,
    EMAIL_ENCRYPTION_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
    EMAIL_HASH_PEPPER: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
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
    VAULT_ACCESS_ALERT_ROW_THRESHOLD: "1000",
    ...overrides,
  };
}

const authHeaders = (token = INTERNAL_TOKEN) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const reviewHeaders = (token = REVIEW_TOKEN, ip = REVIEW_IP) => ({
  Authorization: `Bearer ${token}`,
  "CF-Connecting-IP": ip,
});

async function logRows(env: TestBindings, operation?: string) {
  const db = createVaultDbClient(env.VAULT_SVC_DATABASE_URL);
  const result = operation
    ? await db.execute(
        sql`SELECT operation, caller, outcome, row_count, subject_ref
            FROM vault.access_log WHERE operation = ${operation} ORDER BY at`,
      )
    : await db.execute(
        sql`SELECT operation, caller, outcome, row_count, subject_ref
            FROM vault.access_log ORDER BY at`,
      );
  return result.rows as unknown as {
    operation: string;
    caller: string;
    outcome: string;
    row_count: number;
    subject_ref: string | null;
  }[];
}

async function countLogRows(env: TestBindings): Promise<number> {
  const db = createVaultDbClient(env.VAULT_SVC_DATABASE_URL);
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM vault.access_log`);
  return (result.rows[0] as unknown as { n: number }).n;
}

// Turnstile is stubbed the same way epic.test.ts does it.
beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitEpic(env: TestBindings) {
  const res = await app.request(
    "/public/epic/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        epicNumber: `ABC${Math.floor(1000000 + Math.random() * 8999999)}`,
        assemblySegmentClaimed: "Kochi",
        docBase64: "ZmFrZS1kb2M=",
        turnstileToken: "tok",
      }),
    },
    env,
  );
  return (await res.json()) as { docRef: string };
}

describe("vault access log — internal registration reads", () => {
  it("logs the duplicate-email probe on registration start", async () => {
    const env = testEnv();
    const before = await countLogRows(env);

    const res = await app.request(
      "/internal/registrations/start",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email: `alog-${randomUUID()}@example.com`,
          pseudonym: `Alog${randomUUID().slice(0, 8)}`,
          locale: "ml",
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await countLogRows(env)).toBe(before + 1);

    const rows = await logRows(env, "registration.start.duplicate_check");
    const latest = rows.at(-1);
    // A fresh email finds nothing — but the probe still happened, and a
    // zero-row answer is still a fact about a real person's email.
    expect(latest?.outcome).toBe("not_found");
    expect(latest?.row_count).toBe(0);
    expect(latest?.caller).toBe("internal");
  });

  it("logs a consume that returns identity data (pseudonym leaves the vault)", async () => {
    const env = testEnv();
    const start = await app.request(
      "/internal/registrations/start",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email: `alog-${randomUUID()}@example.com`,
          pseudonym: `Alog${randomUUID().slice(0, 8)}`,
          locale: "ml",
        }),
      },
      env,
    );
    const { registrationId, rawToken } = (await start.json()) as {
      registrationId: string;
      rawToken: string;
    };

    const res = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      env,
    );
    expect(res.status).toBe(200);

    const rows = await logRows(env, "registration.consume");
    const forThisRow = rows.filter((r) => r.subject_ref === registrationId);
    expect(forThisRow).toHaveLength(1);
    expect(forThisRow[0]?.outcome).toBe("ok");
    expect(forThisRow[0]?.row_count).toBe(1);
  });

  it("logs a miss with outcome=not_found for an unknown token", async () => {
    const env = testEnv();
    const res = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken: "nope" }) },
      env,
    );
    expect(res.status).toBe(404);

    const rows = await logRows(env, "registration.consume");
    expect(rows.at(-1)?.outcome).toBe("not_found");
    expect(rows.at(-1)?.row_count).toBe(0);
  });

  it("logs the complete lookup when it misses", async () => {
    const env = testEnv();
    const unknownId = randomUUID();
    const res = await app.request(
      `/internal/registrations/${unknownId}/complete`,
      { method: "POST", headers: authHeaders() },
      env,
    );
    expect(res.status).toBe(404);

    const rows = await logRows(env, "registration.complete.lookup");
    const mine = rows.filter((r) => r.subject_ref === unknownId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.outcome).toBe("not_found");
  });
});

describe("vault access log — EPIC reads", () => {
  it("logs the link lookup with the docRef as subject", async () => {
    const env = testEnv();
    const { docRef } = await submitEpic(env);

    await app.request(
      "/internal/epic/link",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ memberId: randomUUID(), docRef }),
      },
      env,
    );

    const rows = await logRows(env, "epic.link.lookup");
    const mine = rows.filter((r) => r.subject_ref === docRef);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.outcome).toBe("ok");
    expect(mine[0]?.row_count).toBe(1);
  });

  it("logs a member-scoped status read", async () => {
    const env = testEnv();
    const memberId = randomUUID();
    const { docRef } = await submitEpic(env);
    await app.request(
      "/internal/epic/link",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ memberId, docRef }) },
      env,
    );

    const res = await app.request(
      `/internal/epic/status?memberId=${memberId}`,
      { headers: authHeaders() },
      env,
    );
    expect(res.status).toBe(200);

    // subjectRef is the verification row id, deliberately NOT the memberId —
    // see the comment at that logVaultAccess call in epic.ts.
    const rows = await logRows(env, "epic.status");
    const latest = rows.at(-1);
    expect(latest?.outcome).toBe("ok");
    expect(latest?.subject_ref).not.toBe(memberId);
    expect(latest?.subject_ref).not.toBeNull();
  });

  // The whole reason this table has a row_count column: one call to the review
  // queue decrypts every pending row's EPIC number AND uploaded document.
  it("logs the review queue with a row_count matching the rows exposed", async () => {
    const env = testEnv();
    const memberIds = [randomUUID(), randomUUID()];
    for (const memberId of memberIds) {
      const { docRef } = await submitEpic(env);
      await app.request(
        "/internal/epic/link",
        { method: "POST", headers: authHeaders(), body: JSON.stringify({ memberId, docRef }) },
        env,
      );
    }

    const res = await app.request("/review/epic/queue", { headers: reviewHeaders() }, env);
    expect(res.status).toBe(200);
    const queue = (await res.json()) as unknown[];

    const rows = await logRows(env, "epic.review_queue");
    const latest = rows.at(-1);
    expect(latest?.caller).toBe("review");
    expect(latest?.row_count).toBe(queue.length);
    expect(latest?.row_count).toBeGreaterThanOrEqual(2);
    // A bulk read has no single subject; recording every member_id here would
    // make the audit row a second copy of the queue.
    expect(latest?.subject_ref).toBeNull();
  });

  it("emits a structured bulk-access alert once the row threshold is exceeded", async () => {
    const env = testEnv({ VAULT_ACCESS_ALERT_ROW_THRESHOLD: "1" });
    const { docRef } = await submitEpic(env);
    await app.request(
      "/internal/epic/link",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ memberId: randomUUID(), docRef }),
      },
      env,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await app.request("/review/epic/queue", { headers: reviewHeaders() }, env);
      const payloads = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("vault_bulk_access"))
        .map((line) => JSON.parse(line));
      expect(payloads.length).toBeGreaterThanOrEqual(1);
      const alert = payloads.at(-1);
      expect(alert.operation).toBe("epic.review_queue");
      expect(alert.caller).toBe("review");
      expect(alert.rowCount).toBeGreaterThan(1);
      // The alert says a bulk read happened — never what it contained.
      const serialised = JSON.stringify(alert);
      expect(serialised).not.toContain("ABC");
      expect(serialised).not.toContain("ZmFrZS1kb2M");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("vault access log — invariant guarantees", () => {
  // An unauthenticated caller must not be able to write to the audit log at
  // all: otherwise anyone could flood it and bury a real read.
  it("does not log anything for a request rejected by the auth gate", async () => {
    const env = testEnv();
    const before = await countLogRows(env);

    const res = await app.request(
      `/internal/epic/status?memberId=${randomUUID()}`,
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await countLogRows(env)).toBe(before);
  });

  // The database enums are the real guarantee (migration 0002); this checks the
  // TS vocabularies have not drifted from them. A value the code can emit but
  // the enum rejects would fail at runtime, in the vault, on a read — which is
  // the worst possible place to discover a typo.
  it.each([
    ["vault_access_operation", [...VAULT_ACCESS_OPERATIONS]],
    ["vault_access_caller", ["internal", "review"]],
    ["vault_access_outcome", ["ok", "not_found", "denied"]],
  ])("keeps the %s enum in sync with the TS vocabulary", async (typeName, expected) => {
    const db = createVaultDbClient(testEnv().VAULT_SVC_DATABASE_URL);
    const result = await db.execute(
      sql`SELECT e.enumlabel AS label
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'vault' AND t.typname = ${typeName}
          ORDER BY e.enumsortorder`,
    );
    const dbLabels = (result.rows as unknown as { label: string }[]).map((r) => r.label);
    expect(dbLabels.sort()).toEqual([...(expected as string[])].sort());
  });

  it("writes only uuid subject refs, never a civic identifier", async () => {
    const env = testEnv();
    const rows = await logRows(env);
    expect(rows.length).toBeGreaterThan(0);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of rows) {
      if (row.subject_ref !== null) {
        expect(row.subject_ref).toMatch(uuidRe);
      }
    }
  });

  it("records the authorising gate, never the token or the caller IP", async () => {
    const env = testEnv();
    const rows = await logRows(env);
    for (const row of rows) {
      expect(["internal", "review"]).toContain(row.caller);
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain(INTERNAL_TOKEN);
      expect(serialised).not.toContain(REVIEW_TOKEN);
      expect(serialised).not.toContain(REVIEW_IP);
    }
  });
});
