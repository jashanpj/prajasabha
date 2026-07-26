import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "./turnstile";

describe("verifyTurnstile", () => {
  it("returns true when Cloudflare reports success", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const ok = await verifyTurnstile("token-abc", "secret-key", "1.2.3.4", fetchImpl);
    expect(ok).toBe(true);

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [url, init] = call;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("secret")).toBe("secret-key");
    expect(body.get("response")).toBe("token-abc");
    expect(body.get("remoteip")).toBe("1.2.3.4");
  });

  it("returns false when Cloudflare reports failure", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200 },
        ),
    );
    const ok = await verifyTurnstile("bad-token", "secret-key", undefined, fetchImpl);
    expect(ok).toBe(false);
  });

  it("returns false (fails closed) when the verify call itself errors", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error("network down");
    });
    const ok = await verifyTurnstile("token-abc", "secret-key", "1.2.3.4", fetchImpl);
    expect(ok).toBe(false);
  });

  it("returns false when the response isn't 200", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("nope", { status: 500 }),
    );
    const ok = await verifyTurnstile("token-abc", "secret-key", "1.2.3.4", fetchImpl);
    expect(ok).toBe(false);
  });
});
