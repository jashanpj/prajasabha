// B3's admin-only merge endpoint (issue #26). There is no admin-role model
// anywhere in this codebase yet, so this mirrors
// apps/vault-svc/src/review-auth.ts's requireReviewAccess almost verbatim:
// two independent factors (a correct Authorization: Bearer token AND an
// allow-listed caller IP) — a leaked merge-admin token alone must not grant
// access from a non-allow-listed IP, and vice versa. Unlike vault-svc
// (Hono middleware), apps/web has no Hono, so this is a plain function
// taking the caller's IP as an explicit parameter rather than reading a
// header off a framework request object — callers pass Astro's own
// `clientAddress` (same as handleStart's clientAddress parameter in
// apps/web/src/pages/api/auth/register/start.ts).
export function requireAdminAccess(
  request: Request,
  clientAddress: string,
  expectedToken: string,
  allowedIps: string[],
): boolean {
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
    return false;
  }
  if (!allowedIps.includes(clientAddress)) {
    return false;
  }
  return true;
}

// Manual constant-time compare (no Node crypto.timingSafeEqual dependency,
// so this runs the same way in Workers without nodejs_compat) — identical
// implementation to apps/vault-svc/src/auth.ts's timingSafeEqual. Always
// walks the full length of the longer string so an attacker can't learn
// the token length from response timing either.
function timingSafeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
