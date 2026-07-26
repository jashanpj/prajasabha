import type { MiddlewareHandler } from "hono";

/**
 * Bearer-token check for every /internal/* route — apps/vault-svc is only
 * ever called by apps/web via a Cloudflare service binding (env.VAULT_SVC),
 * never a public URL, but the binding call is still a real HTTP request
 * Hono has to authenticate. Not mTLS (real prod hardening, correctly
 * deferred per todo.md's #23 exclusion) — a shared secret is sufficient
 * for this MVP's threat model and is trivially upgradeable later.
 */
export function requireInternalToken(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}

// Manual constant-time compare (no Node crypto.timingSafeEqual dependency,
// so this runs the same way in Workers without nodejs_compat). Always
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
