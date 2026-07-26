import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireReviewAccess } from "./review-auth";

// Issue #22 (A3 — T2 verification): the human-reviewer queue
// (`/review/epic/*`) is a *different* threat model from the
// service-to-service `/internal/*` routes auth.test.ts covers — a human
// reviewer's browser, not another Cloudflare Worker. Two independent
// factors are required: a shared bearer token AND an IP allowlist
// (CF-Connecting-IP), mirroring auth.ts's structure but never conflatable
// with `requireInternalToken` (a single leaked review-queue token must not
// grant `/internal/*` access, and vice versa).

const TOKEN = "review-queue-token";
const ALLOWED_IPS = ["203.0.113.10", "203.0.113.11"];

function testApp(expectedToken: string, allowedIps: string[]) {
  const app = new Hono();
  app.use("*", requireReviewAccess(expectedToken, allowedIps));
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

function headers(token: string | undefined, ip: string | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (token !== undefined) h.Authorization = `Bearer ${token}`;
  if (ip !== undefined) h["CF-Connecting-IP"] = ip;
  return h;
}

describe("requireReviewAccess", () => {
  it("allows a request with the correct token AND an allowlisted IP", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers(TOKEN, ALLOWED_IPS[0]) });
    expect(res.status).toBe(200);
  });

  it("allows any IP that appears in the allowlist, not just the first", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers(TOKEN, ALLOWED_IPS[1]) });
    expect(res.status).toBe(200);
  });

  it("rejects the correct token from a non-allowlisted IP", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers(TOKEN, "198.51.100.1") });
    expect(res.status).toBe(401);
  });

  it("rejects an allowlisted IP with the wrong token", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers("wrong-token", ALLOWED_IPS[0]) });
    expect(res.status).toBe(401);
  });

  it("rejects a request with no Authorization header at all", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers(undefined, ALLOWED_IPS[0]) });
    expect(res.status).toBe(401);
  });

  it("rejects a request with no CF-Connecting-IP header at all", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", { headers: headers(TOKEN, undefined) });
    expect(res.status).toBe(401);
  });

  it("rejects a request with neither header present", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header (not Bearer-prefixed), even from an allowlisted IP", async () => {
    const app = testApp(TOKEN, ALLOWED_IPS);
    const res = await app.request("/ping", {
      headers: { Authorization: TOKEN, "CF-Connecting-IP": ALLOWED_IPS[0] as string },
    });
    expect(res.status).toBe(401);
  });

  it("rejects every request when the allowlist is empty, even with the correct token", async () => {
    const app = testApp(TOKEN, []);
    const res = await app.request("/ping", { headers: headers(TOKEN, "203.0.113.10") });
    expect(res.status).toBe(401);
  });
});
