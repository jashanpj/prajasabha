import { randomUUID } from "node:crypto";
import { signSession } from "shared";
import { describe, expect, it, vi } from "vitest";
import { handleSubmit } from "./submit";

// Issue #22 (A3 — T2 verification). handleSubmit is session-authed (reads
// the `ps_session` cookie verify.ts issues) and proxies to apps/vault-svc's
// `/internal/epic/link` via the VAULT_SVC service binding — mirrors
// start.ts/verify.ts's mocking style exactly (fakeVaultSvc, no real
// network). Body shape comes from packages/shared's ALREADY-COMMITTED
// `epicVerificationSubmissionSchema` ({memberId, docRef}) — not redefined
// here.

function fakeVaultSvc(response: { status: number; body: unknown }) {
  return {
    fetch: vi.fn(
      async () => new Response(JSON.stringify(response.body), { status: response.status }),
    ),
  };
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

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    VAULT_SVC: fakeVaultSvc({
      status: 200,
      body: { verificationId: randomUUID(), status: "pending" },
    }),
    VAULT_SVC_INTERNAL_TOKEN: "internal-token",
    SESSION_SECRET: "session-secret",
    RATE_LIMIT_KV: fakeKv(),
    EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

function callSubmit(
  body: unknown,
  env: ReturnType<typeof testEnv>,
  cookie?: string,
): ReturnType<typeof handleSubmit> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request("https://prajasabha.example/api/verify/epic/submit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleSubmit(request, env);
}

describe("handleSubmit (POST /api/verify/epic/submit)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callSubmit({ memberId: randomUUID(), docRef: randomUUID() }, testEnv());
    expect(res.status).toBe(401);
  });

  it("returns 403 when body.memberId does not match the session's memberId", async () => {
    const sessionMemberId = randomUUID();
    const bodyMemberId = randomUUID();
    const cookie = await sessionCookie(sessionMemberId);

    const res = await callSubmit(
      { memberId: bodyMemberId, docRef: randomUUID() },
      testEnv(),
      cookie,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a malformed body (missing docRef)", async () => {
    const memberId = randomUUID();
    const cookie = await sessionCookie(memberId);
    const res = await callSubmit({ memberId }, testEnv(), cookie);
    expect(res.status).toBe(400);
  });

  it("rejects once the per-member rate limit is exceeded", async () => {
    const memberId = randomUUID();
    const cookie = await sessionCookie(memberId);
    const env = testEnv({ EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });

    const first = await callSubmit({ memberId, docRef: randomUUID() }, env, cookie);
    expect(first.status).toBe(202);

    const second = await callSubmit({ memberId, docRef: randomUUID() }, env, cookie);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
  });

  it("returns 202 on the happy path, proxying vault-svc's /internal/epic/link call", async () => {
    const memberId = randomUUID();
    const docRef = randomUUID();
    const cookie = await sessionCookie(memberId);
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({
        status: 200,
        body: { verificationId: docRef, status: "pending" },
      }),
    });

    const res = await callSubmit({ memberId, docRef }, env, cookie);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ verificationId: docRef, status: "pending" });
    expect(env.VAULT_SVC.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes through vault-svc's 409 duplicate_epic response unchanged", async () => {
    const memberId = randomUUID();
    const docRef = randomUUID();
    const cookie = await sessionCookie(memberId);
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({ status: 409, body: { error: "duplicate_epic" } }),
    });

    const res = await callSubmit({ memberId, docRef }, env, cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_epic" });
  });

  it("passes through vault-svc's 404 unknown_doc_ref response unchanged", async () => {
    const memberId = randomUUID();
    const docRef = randomUUID();
    const cookie = await sessionCookie(memberId);
    const env = testEnv({
      VAULT_SVC: fakeVaultSvc({ status: 404, body: { error: "unknown_doc_ref" } }),
    });

    const res = await callSubmit({ memberId, docRef }, env, cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_doc_ref" });
  });
});
