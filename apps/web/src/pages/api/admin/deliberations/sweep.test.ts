import { describe, expect, it } from "vitest";
import { handleSweep } from "./sweep";

// Issue #35 — C3's demo-only manual sweep trigger. handleSweep does no DB
// work itself (it forwards to apps/jobs over a service binding), so unlike
// most endpoint tests here, this one needs no real Postgres — just the
// admin auth gate and the forwarding behavior.

const ADMIN_TOKEN = "sweep-admin-token";
const ALLOWED_IP = "127.0.0.1";
const NOT_ALLOWED_IP = "203.0.113.99";
const JOBS_TOKEN = "jobs-internal-token";

function fakeJobsSvc(response: Response) {
  return {
    calls: [] as Request[],
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      this.calls.push(request);
      return response.clone();
    },
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    DELIBERATION_SWEEP_ADMIN_TOKEN: ADMIN_TOKEN,
    DELIBERATION_SWEEP_ADMIN_IP_ALLOWLIST: ALLOWED_IP,
    JOBS_INTERNAL_TOKEN: JOBS_TOKEN,
    JOBS_SVC: fakeJobsSvc(Response.json({ closed: [], summarized: [] }, { status: 200 })),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

function callSweep(env: ReturnType<typeof testEnv>, token?: string, clientAddress = ALLOWED_IP) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const request = new Request("https://prajasabha.example/api/admin/deliberations/sweep", {
    method: "POST",
    headers,
  });
  return handleSweep(request, env, clientAddress);
}

describe("handleSweep (POST /api/admin/deliberations/sweep)", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await callSweep(testEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await callSweep(testEnv(), "wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 from a non-allow-listed IP even with the correct token", async () => {
    const res = await callSweep(testEnv(), ADMIN_TOKEN, NOT_ALLOWED_IP);
    expect(res.status).toBe(401);
  });

  it("forwards to JOBS_SVC with the JOBS_INTERNAL_TOKEN bearer, and passes through its response", async () => {
    const env = testEnv();
    const res = await callSweep(env, ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: [], summarized: [] });

    expect(env.JOBS_SVC.calls).toHaveLength(1);
    const forwarded = env.JOBS_SVC.calls[0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(new URL(forwarded.url).pathname).toBe("/internal/sweep");
    expect(forwarded.headers.get("Authorization")).toBe(`Bearer ${JOBS_TOKEN}`);
  });

  it("passes through a non-200 status from JOBS_SVC unchanged", async () => {
    const env = testEnv({
      JOBS_SVC: fakeJobsSvc(Response.json({ error: "unauthorized" }, { status: 401 })),
    });
    const res = await callSweep(env, ADMIN_TOKEN);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
