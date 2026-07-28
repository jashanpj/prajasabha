import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Bindings } from "./env";
import app from "./index";

const INTERNAL_TOKEN = "test-internal-token";

function testEnv(overrides: Partial<Bindings> = {}): Bindings {
  const vaultSvcDatabaseUrl = process.env.VAULT_SVC_DATABASE_URL;
  if (!vaultSvcDatabaseUrl) {
    throw new Error(
      "VAULT_SVC_DATABASE_URL is not set. apps/vault-svc tests need a real Postgres " +
        "(docker compose up -d, then copy .env.example to .env) — see CONTRIBUTING.md.",
    );
  }
  return {
    VAULT_SVC_DATABASE_URL: vaultSvcDatabaseUrl,
    // 32-byte (256-bit) test-only keys, base64 — sized correctly for
    // AES-GCM-256 / HMAC-SHA256, never used outside this test file.
    // Deliberately low-entropy (repeated-byte fill, not randomly
    // generated) so they read as obviously-fake to gitleaks/a human, not
    // a plausible leaked key.
    EMAIL_ENCRYPTION_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
    EMAIL_HASH_PEPPER: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
    VAULT_SVC_INTERNAL_TOKEN: INTERNAL_TOKEN,
    MAGIC_LINK_TTL_MINUTES: "15",
    // Issue #16/#22 — EPIC verification (unused by this file's own tests,
    // but required to satisfy the full Bindings type since index.ts now
    // mounts epic.ts's routes onto this same app).
    EPIC_HASH_PEPPER: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    EPIC_ENCRYPTION_KEY: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
    EPIC_DOC_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    REVIEW_QUEUE_TOKEN: "review-queue-token",
    REVIEW_QUEUE_IP_ALLOWLIST: "127.0.0.1",
    RATE_LIMIT_KV: {
      async get() {
        return null;
      },
      async put() {},
    } as unknown as KVNamespace,
    EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "1000",
    VAULT_ACCESS_ALERT_ROW_THRESHOLD: "1000",
    ...overrides,
  };
}

function authHeaders(token: string = INTERNAL_TOKEN) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function startRegistration(
  email: string,
  pseudonym = `Pseudonym-${randomUUID().slice(0, 8)}`,
) {
  const res = await app.request(
    "/internal/registrations/start",
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, pseudonym, locale: "ml" }),
    },
    testEnv(),
  );
  return res;
}

function complete(registrationId: string) {
  return app.request(
    `/internal/registrations/${registrationId}/complete`,
    { method: "POST", headers: authHeaders() },
    testEnv(),
  );
}

describe("bearer-token authz (every /internal/* route)", () => {
  it("rejects a request with no token", async () => {
    const res = await app.request(
      "/internal/registrations/start",
      { method: "POST", body: JSON.stringify({}) },
      testEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await app.request(
      "/internal/registrations/start",
      { method: "POST", headers: authHeaders("wrong-token"), body: JSON.stringify({}) },
      testEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/registrations/start", () => {
  it("creates a pending registration and returns a raw token", async () => {
    const res = await startRegistration(`start-${randomUUID()}@example.com`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registrationId: string; rawToken: string };
    expect(body.registrationId).toBeTruthy();
    expect(body.rawToken).toBeTruthy();
  });

  it("rejects a duplicate email that already has a completed registration", async () => {
    const email = `dup-${randomUUID()}@example.com`;
    const first = await startRegistration(email);
    const { registrationId, rawToken } = (await first.json()) as {
      registrationId: string;
      rawToken: string;
    };

    const consumeRes = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );
    expect(consumeRes.status).toBe(200);
    await complete(registrationId);

    const second = await startRegistration(email);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ reason: "duplicate_email" });
  });

  it("allows re-requesting a pending (never-completed) registration for the same email", async () => {
    const email = `pending-${randomUUID()}@example.com`;
    const first = await startRegistration(email);
    expect(first.status).toBe(200);
    const second = await startRegistration(email);
    expect(second.status).toBe(200);
  });
});

describe("POST /internal/registrations/consume", () => {
  it("consumes a valid token exactly once", async () => {
    const startRes = await startRegistration(`consume-${randomUUID()}@example.com`);
    const { rawToken } = (await startRes.json()) as { rawToken: string; registrationId: string };

    const consumeRes = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );
    expect(consumeRes.status).toBe(200);
    const body = (await consumeRes.json()) as { pseudonym: string; locale: string };
    expect(body.pseudonym).toMatch(/^Pseudonym-/);
    expect(body.locale).toBe("ml");
  });

  it("rejects consuming the same token twice", async () => {
    const startRes = await startRegistration(`double-consume-${randomUUID()}@example.com`);
    const { rawToken } = (await startRes.json()) as { rawToken: string };

    const firstConsume = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );
    expect(firstConsume.status).toBe(200);

    const secondConsume = await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );
    expect(secondConsume.status).toBe(410);
  });

  it("rejects an unknown token", async () => {
    const res = await app.request(
      "/internal/registrations/consume",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ rawToken: "unknown-token" }),
      },
      testEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("exactly one of two concurrent consumes for the same token succeeds", async () => {
    const startRes = await startRegistration(`race-${randomUUID()}@example.com`);
    const { rawToken } = (await startRes.json()) as { rawToken: string };

    const consumeOnce = () =>
      app.request(
        "/internal/registrations/consume",
        { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
        testEnv(),
      );

    const [a, b] = await Promise.all([consumeOnce(), consumeOnce()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
  });
});

describe("POST /internal/registrations/:id/complete", () => {
  it("marks a consumed registration complete (a bare boolean flip, no member_id ever stored)", async () => {
    const startRes = await startRegistration(`complete-${randomUUID()}@example.com`);
    const { registrationId, rawToken } = (await startRes.json()) as {
      registrationId: string;
      rawToken: string;
    };
    await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );

    const res = await complete(registrationId);
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown registration id", async () => {
    const res = await complete(randomUUID());
    expect(res.status).toBe(404);
  });

  it("returns 409 when the registration is already complete", async () => {
    const startRes = await startRegistration(`already-complete-${randomUUID()}@example.com`);
    const { registrationId, rawToken } = (await startRes.json()) as {
      registrationId: string;
      rawToken: string;
    };
    await app.request(
      "/internal/registrations/consume",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ rawToken }) },
      testEnv(),
    );
    await complete(registrationId);

    const secondComplete = await complete(registrationId);
    expect(secondComplete.status).toBe(409);
  });

  it("returns 409 when the registration has not been consumed yet", async () => {
    const startRes = await startRegistration(`not-consumed-${randomUUID()}@example.com`);
    const { registrationId } = (await startRes.json()) as { registrationId: string };

    const res = await complete(registrationId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_yet_consumed" });
  });
});
