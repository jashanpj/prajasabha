import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireInternalToken } from "./auth";

function testApp(expectedToken: string) {
  const app = new Hono();
  app.use("*", requireInternalToken(expectedToken));
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("requireInternalToken", () => {
  it("allows a request with the correct bearer token", async () => {
    const app = testApp("correct-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Bearer correct-token" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a request with no Authorization header", async () => {
    const app = testApp("correct-token");
    const res = await app.request("/ping");
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const app = testApp("correct-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header (not Bearer-prefixed)", async () => {
    const app = testApp("correct-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "correct-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an empty bearer token even if expectedToken is also empty", async () => {
    const app = testApp("");
    const res = await app.request("/ping", { headers: { Authorization: "Bearer " } });
    expect(res.status).toBe(401);
  });
});
