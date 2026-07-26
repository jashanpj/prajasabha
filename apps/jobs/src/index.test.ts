import { describe, expect, it } from "vitest";
import worker, { type JobsEnv } from "./index";

describe("apps/jobs entrypoint", () => {
  it("fetch handler responds 200 for local wrangler dev testability", async () => {
    const res = await worker.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
  });
});

// Issue #35 — the demo-only manual sweep trigger. Same real-Postgres
// convention as lifecycle-sweep.test.ts; runSweep() (index.ts) constructs
// its own db client from env.APP_DATABASE_URL, so these hit a real DB too,
// just with zero due deliberations (asserting only the auth gate and the
// response shape, not sweep behavior itself — that's lifecycle-sweep.test.ts's job).
function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

function testEnv(overrides: Partial<JobsEnv> = {}): JobsEnv {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    // biome-ignore lint/suspicious/noExplicitAny: fake R2Bucket for unit tests — only .put() is ever called
    DELIBERATION_ARTIFACTS: { async put() {} } as any,
    CONSENSUS_AGREEMENT_THRESHOLD_PERCENT: "70",
    CONSENSUS_MIN_VOTERS: "30",
    JOBS_INTERNAL_TOKEN: "test-jobs-internal-token",
    ...overrides,
  };
}

function callSweep(env: JobsEnv, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request("http://localhost/internal/sweep", { method: "POST", headers }),
    env,
  );
}

describe("POST /internal/sweep (demo-only manual trigger — issue #35)", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await callSweep(testEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await callSweep(testEnv(), "wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 200 with a {closed, summarized} body on the correct token", async () => {
    const res = await callSweep(testEnv(), "test-jobs-internal-token");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("closed");
    expect(body).toHaveProperty("summarized");
  });
});
