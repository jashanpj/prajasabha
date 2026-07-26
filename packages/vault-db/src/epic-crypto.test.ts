import { describe, expect, it } from "vitest";
import {
  decryptDoc,
  decryptEpicNumber,
  encryptDoc,
  encryptEpicNumber,
  hashEmail,
  hashEpicNumber,
  normalizeEpicNumber,
} from "./crypto";

function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64");
}

describe("normalizeEpicNumber", () => {
  it("trims and uppercases", () => {
    expect(normalizeEpicNumber("  abc1234567  ")).toBe("ABC1234567");
  });

  it("makes case/whitespace variants normalize identically", () => {
    expect(normalizeEpicNumber(" abc1234567")).toBe(normalizeEpicNumber("ABC1234567 "));
  });
});

describe("encryptEpicNumber / decryptEpicNumber", () => {
  it("round-trips the original EPIC number", async () => {
    const key = randomKeyB64();
    const { ciphertext, iv } = await encryptEpicNumber("ABC1234567", key);
    const decrypted = await decryptEpicNumber(ciphertext, iv, key);
    expect(decrypted).toBe("ABC1234567");
  });

  it("produces a different IV (and ciphertext) for the same plaintext on each call", async () => {
    const key = randomKeyB64();
    const first = await encryptEpicNumber("ABC1234567", key);
    const second = await encryptEpicNumber("ABC1234567", key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = randomKeyB64();
    const wrongKey = randomKeyB64();
    const { ciphertext, iv } = await encryptEpicNumber("ABC1234567", key);
    await expect(decryptEpicNumber(ciphertext, iv, wrongKey)).rejects.toThrow();
  });

  it("fails to decrypt with a tampered ciphertext", async () => {
    const key = randomKeyB64();
    const { ciphertext, iv } = await encryptEpicNumber("ABC1234567", key);
    const tamperedBytes = Buffer.from(ciphertext, "base64");
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    await expect(decryptEpicNumber(tamperedBytes.toString("base64"), iv, key)).rejects.toThrow();
  });
});

describe("encryptDoc / decryptDoc", () => {
  it("round-trips an arbitrary base64 document/photo blob", async () => {
    const key = randomKeyB64();
    const docBase64 = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");
    const { ciphertext, iv } = await encryptDoc(docBase64, key);
    const decrypted = await decryptDoc(ciphertext, iv, key);
    expect(decrypted).toBe(docBase64);
  });

  it("produces a different IV (and ciphertext) for the same blob on each call", async () => {
    const key = randomKeyB64();
    const docBase64 = "ZmFrZS1kb2N1bWVudC1ieXRlcw==";
    const first = await encryptDoc(docBase64, key);
    const second = await encryptDoc(docBase64, key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = randomKeyB64();
    const wrongKey = randomKeyB64();
    const { ciphertext, iv } = await encryptDoc("ZmFrZS1kb2N1bWVudC1ieXRlcw==", key);
    await expect(decryptDoc(ciphertext, iv, wrongKey)).rejects.toThrow();
  });

  it("uses a key distinct from EPIC-number encryption (key separation)", async () => {
    const docKey = randomKeyB64();
    const epicKey = randomKeyB64();
    const { ciphertext, iv } = await encryptDoc("ZmFrZS1kb2N1bWVudC1ieXRlcw==", docKey);
    await expect(decryptDoc(ciphertext, iv, epicKey)).rejects.toThrow();
  });
});

describe("hashEpicNumber", () => {
  it("is deterministic for the same EPIC number + pepper", async () => {
    const pepper = randomKeyB64();
    const a = await hashEpicNumber("ABC1234567", pepper);
    const b = await hashEpicNumber("ABC1234567", pepper);
    expect(a).toBe(b);
  });

  it("differs for a different pepper", async () => {
    const a = await hashEpicNumber("ABC1234567", randomKeyB64());
    const b = await hashEpicNumber("ABC1234567", randomKeyB64());
    expect(a).not.toBe(b);
  });

  it("differs for a different EPIC number", async () => {
    const pepper = randomKeyB64();
    const a = await hashEpicNumber("ABC1234567", pepper);
    const b = await hashEpicNumber("XYZ7654321", pepper);
    expect(a).not.toBe(b);
  });

  it("is not reversible-looking (hex digest, not the EPIC number itself)", async () => {
    const hash = await hashEpicNumber("ABC1234567", randomKeyB64());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes case/whitespace variants to the same hash", async () => {
    const pepper = randomKeyB64();
    const a = await hashEpicNumber("  abc1234567  ", pepper);
    const b = await hashEpicNumber("ABC1234567", pepper);
    expect(a).toBe(b);
  });

  it("differs from hashEmail's output for the same underlying secret material (key separation)", async () => {
    const sharedSecretMaterial = randomKeyB64();
    const emailHash = await hashEmail("abc1234567@example.com", sharedSecretMaterial);
    const epicHash = await hashEpicNumber("abc1234567", sharedSecretMaterial);
    expect(epicHash).not.toBe(emailHash);
  });
});
