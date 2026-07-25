import { randomUUID } from "node:crypto";
import { schema } from "db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handleStart } from "./start";

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function fakeVaultSvc(response: { status: number; body: unknown }) {
  return {
    fetch: vi.fn(
      async () => new Response(JSON.stringify(response.body), { status: response.status }),
    ),
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    RATE_LIMIT_KV: fakeKv(),
    VAULT_SVC: fakeVaultSvc({
      status: 200,
      body: { registrationId: randomUUID(), rawToken: "raw-token" },
    }),
    VAULT_SVC_INTERNAL_TOKEN: "internal-token",
    RESEND_API_KEY: "resend-key",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    TURNSTILE_SITE_KEY: "turnstile-site",
    SESSION_SECRET: "session-secret",
    MAGIC_LINK_TTL_MINUTES: "15",
    REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: "5",
    REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: "20",
    VERIFY_RATE_LIMIT_PER_IP_PER_HOUR: "30",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

function callStart(body: unknown, env: ReturnType<typeof testEnv>, clientAddress = "203.0.113.1") {
  const request = new Request("https://prajasabha.example/api/auth/register/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return handleStart(request, clientAddress, env);
}

const validBody = {
  email: `voter-${randomUUID()}@example.com`,
  pseudonym: `Pseudonym-${randomUUID().slice(0, 8)}`,
  locale: "ml",
  turnstileToken: "valid-turnstile-token",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch call to ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("handleStart (POST /api/auth/register/start)", () => {
  it("returns 202 on the happy path and calls vault-svc + Resend", async () => {
    const env = testEnv();
    const res = await callStart(validBody, env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });
    expect(env.VAULT_SVC.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body", async () => {
    const res = await callStart({ email: "not-an-email" }, testEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
  });

  it("rejects when Turnstile verification fails", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("challenges.cloudflare.com")) {
        return new Response(JSON.stringify({ success: false }), { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as typeof fetch;

    const res = await callStart(validBody, testEnv());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("turnstile_failed");
  });

  it("rejects when the per-IP rate limit is exceeded", async () => {
    const env = testEnv({ REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: "1" });
    const first = await callStart(
      { ...validBody, email: `a-${randomUUID()}@example.com` },
      env,
      "198.51.100.9",
    );
    expect(first.status).toBe(202);

    const second = await callStart(
      { ...validBody, email: `b-${randomUUID()}@example.com` },
      env,
      "198.51.100.9",
    );
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("rejects when the per-email rate limit is exceeded", async () => {
    const env = testEnv({ REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: "1" });
    const email = `repeat-${randomUUID()}@example.com`;
    const first = await callStart({ ...validBody, email }, env, "198.51.100.1");
    expect(first.status).toBe(202);

    const second = await callStart({ ...validBody, email }, env, "198.51.100.2");
    expect(second.status).toBe(429);
  });

  it("rejects a profane/party-name pseudonym", async () => {
    const res = await callStart(
      { ...validBody, pseudonym: "BJP Supporter", email: `p-${randomUUID()}@example.com` },
      testEnv(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("pseudonym_party_name");
  });

  it("rejects a pseudonym already taken in packages/db", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const takenPseudonym = `Taken-${randomUUID().slice(0, 8)}`;
    const [inserted] = await db
      .insert(schema.members)
      .values({ pseudonym: takenPseudonym, tier: "t0", locale: "ml" })
      .returning({ memberId: schema.members.memberId });

    try {
      const res = await callStart(
        { ...validBody, pseudonym: takenPseudonym, email: `q-${randomUUID()}@example.com` },
        testEnv(),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("pseudonym_taken");
    } finally {
      const { eq } = await import("drizzle-orm");
      await db
        .delete(schema.members)
        .where(eq(schema.members.memberId, inserted?.memberId as string));
    }
  });

  it("returns the identical 202 response for a duplicate email — anti-enumeration", async () => {
    // A caller must never be able to distinguish "new registration" from
    // "email already registered" via the HTTP response — that would leak
    // an identity↔participation correlation over a side channel instead
    // of a DB join. Both cases get {sent: true}; only the email content
    // differs (a notice instead of a magic link), which this test can't
    // observe from the client's perspective by design.
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({ status: 409, body: { reason: "duplicate_email" } }),
    });
    const res = await callStart(validBody, env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });
  });

  it("returns 500 when the email send fails", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("challenges.cloudflare.com")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("api.resend.com")) {
        return new Response("error", { status: 500 });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as typeof fetch;

    const res = await callStart(validBody, testEnv());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("email_send_failed");
  });
});
