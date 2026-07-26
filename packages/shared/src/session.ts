// Minimal signed session cookie, issued by the verify endpoint on
// successful T0 registration (issue #20). This is deliberately not a full
// auth system — no refresh, no server-side session store, no revocation
// — just enough for later mutation endpoints (e.g. B1 "Raise an Issue")
// to know which member_id is making a request. Uses Web Crypto HMAC-SHA256,
// available natively in both Cloudflare Workers and Node 20+ (no extra
// dependency).
export interface Session {
  memberId: string;
}

// No explicit return-type annotation: the `CryptoKey` type name isn't
// globally available under this package's Node-only (no "dom") lib config
// — inferring it from crypto.subtle.importKey's own signature works fine
// and avoids depending on @cloudflare/workers-types just for one type name.
async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `expiresAtEpochMs` is a millisecond epoch timestamp, e.g. Date.now() + 30 days. */
export async function signSession(
  memberId: string,
  secret: string,
  expiresAtEpochMs: number,
): Promise<string> {
  const payload = `${memberId}.${expiresAtEpochMs}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toHex(signature)}`;
}

export async function verifySession(cookieValue: string, secret: string): Promise<Session | null> {
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [memberId, expiresAtRaw, signatureHex] = parts;
  if (!memberId || !expiresAtRaw || !signatureHex) return null;

  const expiresAtEpochMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) return null;

  const payload = `${memberId}.${expiresAtRaw}`;
  const key = await hmacKey(secret);
  // No explicit Uint8Array type annotation here — under a consumer's
  // tsconfig that pulls in @cloudflare/workers-types (e.g. apps/web),
  // the ambient Uint8Array/BufferSource types differ subtly from plain
  // Node's, and an explicit annotation pins the wrong one. Letting
  // inference flow from `new Uint8Array(numberArray)` avoids that.
  const byteValues = signatureHex.match(/../g)?.map((b) => Number.parseInt(b, 16));
  if (!byteValues || byteValues.length === 0) return null;
  const signatureBytes = new Uint8Array(byteValues);

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;

  return { memberId };
}
