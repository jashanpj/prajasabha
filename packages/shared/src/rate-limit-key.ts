/**
 * Unkeyed SHA-256 digest, used to keep PII (e.g. an email address) out of
 * Cloudflare KV keys for rate-limit counters. Not a secret-keyed hash like
 * packages/vault-db/src/crypto.ts's hashEmail (that one guards a
 * permanent, security-relevant duplicate-account correlation and needs a
 * pepper) — this one only needs to avoid storing plaintext PII in a
 * short-TTL cache key, so a plain digest is sufficient and doesn't require
 * sharing the vault's pepper secret with apps/web.
 */
export async function hashRateLimitKeyComponent(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
