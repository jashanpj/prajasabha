import { describe, expect, it } from "vitest";
import { hashRateLimitKeyComponent } from "./rate-limit-key";

describe("hashRateLimitKeyComponent", () => {
  it("is deterministic for the same input", async () => {
    const a = await hashRateLimitKeyComponent("voter@example.com");
    const b = await hashRateLimitKeyComponent("voter@example.com");
    expect(a).toBe(b);
  });

  it("differs for different input", async () => {
    const a = await hashRateLimitKeyComponent("voter-a@example.com");
    const b = await hashRateLimitKeyComponent("voter-b@example.com");
    expect(a).not.toBe(b);
  });

  it("is a hex digest, never the input value itself", async () => {
    const hash = await hashRateLimitKeyComponent("voter@example.com");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("voter");
  });
});
