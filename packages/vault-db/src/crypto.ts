// Email encryption/hashing for the identity vault (issue #20's
// vault.auth_credentials table). Two SEPARATE secrets, never reused for
// both purposes:
//   - EMAIL_ENCRYPTION_KEY: AES-GCM key, reversible — used to actually
//     send mail (Resend needs the real address).
//   - EMAIL_HASH_PEPPER: HMAC key, one-way — used only for equality
//     lookups (duplicate-email detection) without ever exposing the
//     plaintext address from the hash.
// Both use Web Crypto, available natively in Cloudflare Workers and
// Node 20+ — no extra dependency.

const AES_KEY_LENGTH_BITS = 256;
const GCM_IV_LENGTH_BYTES = 12;

/** Lowercase + trim, applied before both hashing and encrypting so
 * "A@B.com" and "a@b.com " collide correctly for duplicate detection. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importAesKey(keyB64: string) {
  const keyBytes = base64ToBytes(keyB64);
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: AES_KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface EncryptedValue {
  ciphertext: string; // base64, includes the AES-GCM auth tag
  iv: string; // base64, 12 random bytes, unique per encryption call
}
// Alias kept for the shape's original name at this table's call sites.
export type EncryptedEmail = EncryptedValue;

export async function encryptEmail(email: string, keyB64: string): Promise<EncryptedValue> {
  return aesGcmEncrypt(normalizeEmail(email), keyB64);
}

/**
 * Decrypts an email encrypted by encryptEmail. Not called anywhere in
 * issue #20's flow (registration never needs to read the email back) —
 * exists now, tested now, for a future admin/DPDP-export or
 * password-less-login-for-returning-users feature that will need it.
 */
export async function decryptEmail(
  ciphertextB64: string,
  ivB64: string,
  keyB64: string,
): Promise<string> {
  return aesGcmDecrypt(ciphertextB64, ivB64, keyB64);
}

/**
 * Deterministic HMAC-SHA256(pepper, normalizedEmail), hex-encoded —
 * equality-lookup only, never reversible. This is what
 * vault.auth_credentials.email_hash stores and what the partial unique
 * index enforces "duplicate email blocked" against.
 */
export async function hashEmail(email: string, pepperB64: string): Promise<string> {
  return hmacSha256Hex(normalizeEmail(email), pepperB64);
}

async function hmacSha256Hex(value: string, pepperB64: string): Promise<string> {
  const pepperBytes = base64ToBytes(pepperB64);
  const key = await crypto.subtle.importKey(
    "raw",
    pepperBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Issue #16/#22 — EPIC (voter ID) verification. Three secrets, all
// distinct from email's and from each other (never reuse a key for two
// purposes, same posture as this file's header comment):
//   - EPIC_HASH_PEPPER: HMAC key, one-way — "one EPIC number = one
//     account" uniqueness lookups (issue #22's AC4).
//   - EPIC_ENCRYPTION_KEY: AES-GCM key, reversible — lets a human reviewer
//     actually read the submitted EPIC number.
//   - EPIC_DOC_ENCRYPTION_KEY: AES-GCM key, reversible, over the uploaded
//     document/photo blob — a third key so a doc-key compromise can't
//     also decrypt EPIC numbers or vice versa.

/** Trim + uppercase — EPIC numbers are alphanumeric, case-insensitive for dedup. */
export function normalizeEpicNumber(epicNumber: string): string {
  return epicNumber.trim().toUpperCase();
}

export async function hashEpicNumber(epicNumber: string, pepperB64: string): Promise<string> {
  return hmacSha256Hex(normalizeEpicNumber(epicNumber), pepperB64);
}

export async function encryptEpicNumber(
  epicNumber: string,
  keyB64: string,
): Promise<EncryptedValue> {
  return aesGcmEncrypt(normalizeEpicNumber(epicNumber), keyB64);
}

export async function decryptEpicNumber(
  ciphertextB64: string,
  ivB64: string,
  keyB64: string,
): Promise<string> {
  return aesGcmDecrypt(ciphertextB64, ivB64, keyB64);
}

/** Encrypts an arbitrary base64-encoded document/photo blob, no normalization. */
export async function encryptDoc(docBase64: string, keyB64: string): Promise<EncryptedValue> {
  return aesGcmEncrypt(docBase64, keyB64);
}

export async function decryptDoc(
  ciphertextB64: string,
  ivB64: string,
  keyB64: string,
): Promise<string> {
  return aesGcmDecrypt(ciphertextB64, ivB64, keyB64);
}

async function aesGcmEncrypt(plaintext: string, keyB64: string): Promise<EncryptedValue> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    iv: bytesToBase64(iv),
  };
}

async function aesGcmDecrypt(
  ciphertextB64: string,
  ivB64: string,
  keyB64: string,
): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuffer);
}
