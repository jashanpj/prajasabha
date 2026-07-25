import { describe, expect, it } from "vitest";
import { checkAndIncrement } from "./rate-limit";

// Minimal in-memory stand-in for the Cloudflare KV surface this module
// needs — real KV's eventual consistency/TTL behavior isn't exercised
// here, just the counting logic.
function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    _store: store,
  };
}

describe("checkAndIncrement", () => {
  it("allows the first request and starts the counter at 1", async () => {
    const kv = fakeKv();
    const result = await checkAndIncrement(kv, "ratelimit:test:a", 5, 3600);
    expect(result).toEqual({ allowed: true, count: 1 });
  });

  it("allows requests up to the limit, then blocks", async () => {
    const kv = fakeKv();
    for (let i = 1; i <= 3; i++) {
      const result = await checkAndIncrement(kv, "ratelimit:test:b", 3, 3600);
      expect(result).toEqual({ allowed: true, count: i });
    }
    const blocked = await checkAndIncrement(kv, "ratelimit:test:b", 3, 3600);
    expect(blocked).toEqual({ allowed: false, count: 3 });
  });

  it("does not increment further once blocked", async () => {
    const kv = fakeKv();
    await checkAndIncrement(kv, "ratelimit:test:c", 1, 3600);
    await checkAndIncrement(kv, "ratelimit:test:c", 1, 3600);
    await checkAndIncrement(kv, "ratelimit:test:c", 1, 3600);
    expect(kv._store.get("ratelimit:test:c")).toBe("1");
  });

  it("tracks separate keys independently", async () => {
    const kv = fakeKv();
    await checkAndIncrement(kv, "ratelimit:test:d1", 1, 3600);
    const other = await checkAndIncrement(kv, "ratelimit:test:d2", 1, 3600);
    expect(other).toEqual({ allowed: true, count: 1 });
  });
});
