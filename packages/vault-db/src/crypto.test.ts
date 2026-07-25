import { describe, expect, it } from "vitest";
import { decryptEmail, encryptEmail, hashEmail, normalizeEmail } from "./crypto";

// 256-bit test keys, generated fresh per test run — never hardcoded
// literals, so nothing here can be mistaken for (or reused as) a real key.
function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64");
}

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Voter@Example.COM  ")).toBe("voter@example.com");
  });
});

describe("encryptEmail / decryptEmail", () => {
  it("round-trips the original email", async () => {
    const key = randomKeyB64();
    const { ciphertext, iv } = await encryptEmail("voter@example.com", key);
    const decrypted = await decryptEmail(ciphertext, iv, key);
    expect(decrypted).toBe("voter@example.com");
  });

  it("produces a different IV (and ciphertext) for the same plaintext on each call", async () => {
    const key = randomKeyB64();
    const first = await encryptEmail("voter@example.com", key);
    const second = await encryptEmail("voter@example.com", key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = randomKeyB64();
    const wrongKey = randomKeyB64();
    const { ciphertext, iv } = await encryptEmail("voter@example.com", key);
    await expect(decryptEmail(ciphertext, iv, wrongKey)).rejects.toThrow();
  });

  it("fails to decrypt with a tampered ciphertext", async () => {
    const key = randomKeyB64();
    const { ciphertext, iv } = await encryptEmail("voter@example.com", key);
    const tamperedBytes = Buffer.from(ciphertext, "base64");
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    await expect(decryptEmail(tamperedBytes.toString("base64"), iv, key)).rejects.toThrow();
  });
});

describe("hashEmail", () => {
  it("is deterministic for the same email + pepper", async () => {
    const pepper = randomKeyB64();
    const a = await hashEmail("voter@example.com", pepper);
    const b = await hashEmail("voter@example.com", pepper);
    expect(a).toBe(b);
  });

  it("differs for a different pepper", async () => {
    const a = await hashEmail("voter@example.com", randomKeyB64());
    const b = await hashEmail("voter@example.com", randomKeyB64());
    expect(a).not.toBe(b);
  });

  it("differs for a different email", async () => {
    const pepper = randomKeyB64();
    const a = await hashEmail("voter-a@example.com", pepper);
    const b = await hashEmail("voter-b@example.com", pepper);
    expect(a).not.toBe(b);
  });

  it("is not reversible-looking (hex digest, not the email itself)", async () => {
    const hash = await hashEmail("voter@example.com", randomKeyB64());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
