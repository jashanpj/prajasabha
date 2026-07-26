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

export interface EncryptedEmail {
  ciphertext: string; // base64, includes the AES-GCM auth tag
  iv: string; // base64, 12 random bytes, unique per encryption call
}

export async function encryptEmail(email: string, keyB64: string): Promise<EncryptedEmail> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(normalizeEmail(email));
  const ciphertextBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    iv: bytesToBase64(iv),
  };
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
  const key = await importAesKey(keyB64);
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Deterministic HMAC-SHA256(pepper, normalizedEmail), hex-encoded —
 * equality-lookup only, never reversible. This is what
 * vault.auth_credentials.email_hash stores and what the partial unique
 * index enforces "duplicate email blocked" against.
 */
export async function hashEmail(email: string, pepperB64: string): Promise<string> {
  const pepperBytes = base64ToBytes(pepperB64);
  const key = await crypto.subtle.importKey(
    "raw",
    pepperBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalizeEmail(email)),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
