import { randomUUID } from "node:crypto";
import { verifySession } from "shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleVerify } from "./verify";

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

interface VaultSvcScript {
  consume?: { status: number; body: unknown };
  complete?: { status: number; body: unknown };
}

function fakeVaultSvc(script: VaultSvcScript) {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/consume")) {
        const r = script.consume ?? { status: 200, body: {} };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url.includes("/complete")) {
        const r = script.complete ?? { status: 200, body: {} };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }),
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    RATE_LIMIT_KV: fakeKv(),
    VAULT_SVC: fakeVaultSvc({}),
    VAULT_SVC_INTERNAL_TOKEN: "internal-token",
    SESSION_SECRET: "session-secret",
    REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: "5",
    REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: "20",
    VERIFY_RATE_LIMIT_PER_IP_PER_HOUR: "30",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

function callVerify(token: string, env: ReturnType<typeof testEnv>, clientAddress = "203.0.113.5") {
  const request = new Request(`https://prajasabha.example/api/auth/register/verify?token=${token}`);
  return handleVerify(request, clientAddress, env);
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("handleVerify (GET /api/auth/register/verify)", () => {
  it("creates a member, sets a session cookie, and redirects on a valid token", async () => {
    const pseudonym = `Verify-${randomUUID().slice(0, 8)}`;
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({
        consume: { status: 200, body: { registrationId: randomUUID(), pseudonym, locale: "ml" } },
      }),
    });

    const res = await callVerify("valid-token", env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBeTruthy();

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ps_session=");
    const cookieValue = setCookie.split("ps_session=")[1]?.split(";")[0] ?? "";
    const session = await verifySession(cookieValue, "session-secret");
    expect(session).not.toBeNull();

    // Cleanup: delete the member row this test created.
    const { getServiceRoleDb } = await import("../../../../lib/db");
    const { schema } = await import("db");
    const { eq } = await import("drizzle-orm");
    const db = getServiceRoleDb(appDatabaseUrl());
    await db.delete(schema.members).where(eq(schema.members.pseudonym, pseudonym));
  });

  it("returns 400 when the token query param is missing", async () => {
    const request = new Request("https://prajasabha.example/api/auth/register/verify");
    const res = await handleVerify(request, "203.0.113.5", testEnv());
    expect(res.status).toBe(400);
  });

  it("returns 404 when vault-svc reports an unknown token", async () => {
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({ consume: { status: 404, body: { error: "invalid_token" } } }),
    });
    const res = await callVerify("unknown-token", env);
    expect(res.status).toBe(404);
  });

  it("returns 410 when vault-svc reports an expired/consumed token", async () => {
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({
        consume: { status: 410, body: { error: "expired_or_consumed_token" } },
      }),
    });
    const res = await callVerify("expired-token", env);
    expect(res.status).toBe(410);
  });

  it("returns 409 registration_conflict when the pseudonym was taken between consume and insert", async () => {
    const { getServiceRoleDb } = await import("../../../../lib/db");
    const { schema } = await import("db");
    const { eq } = await import("drizzle-orm");
    const db = getServiceRoleDb(appDatabaseUrl());

    const racedPseudonym = `Raced-${randomUUID().slice(0, 8)}`;
    const [inserted] = await db
      .insert(schema.members)
      .values({ pseudonym: racedPseudonym, tier: "t0", locale: "ml" })
      .returning({ memberId: schema.members.memberId });

    try {
      const env = testEnv({
        VAULT_SVC: fakeVaultSvc({
          consume: {
            status: 200,
            body: { registrationId: randomUUID(), pseudonym: racedPseudonym, locale: "ml" },
          },
        }),
      });
      const res = await callVerify("raced-token", env);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("registration_conflict");
    } finally {
      await db
        .delete(schema.members)
        .where(eq(schema.members.memberId, inserted?.memberId as string));
    }
  });

  it("still succeeds even if the best-effort complete call fails", async () => {
    const pseudonym = `LinkFail-${randomUUID().slice(0, 8)}`;
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({
        consume: { status: 200, body: { registrationId: randomUUID(), pseudonym, locale: "ml" } },
        complete: { status: 500, body: { error: "internal_error" } },
      }),
    });

    const res = await callVerify("valid-token", env);
    expect(res.status).toBe(303);

    const { getServiceRoleDb } = await import("../../../../lib/db");
    const { schema } = await import("db");
    const { eq } = await import("drizzle-orm");
    const db = getServiceRoleDb(appDatabaseUrl());
    await db.delete(schema.members).where(eq(schema.members.pseudonym, pseudonym));
  });

  it("rejects when the per-IP verify rate limit is exceeded", async () => {
    // Consume result doesn't matter for this test — invalid_token (404) is
    // the cheapest terminal response after the rate-limit check runs.
    const env = testEnv({
      VERIFY_RATE_LIMIT_PER_IP_PER_HOUR: "1",
      VAULT_SVC: fakeVaultSvc({ consume: { status: 404, body: { error: "invalid_token" } } }),
    });
    const first = await callVerify("token-a", env, "198.51.100.20");
    expect(first.status).toBe(404);

    const second = await callVerify("token-b", env, "198.51.100.20");
    expect(second.status).toBe(429);
  });
});
