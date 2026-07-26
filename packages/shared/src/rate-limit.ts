/**
 * Minimal shape of the Cloudflare KV binding this module needs — avoids a
 * hard dependency on @cloudflare/workers-types inside packages/shared,
 * which isn't Workers-specific.
 */
export interface RateLimitKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl: number }): Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

/**
 * Fixed-window rate limiter backed by Cloudflare KV. Callers build `key`
 * to already include the window bucket (e.g. an hour timestamp) so the
 * counter resets naturally via the KV entry's `expirationTtl` — see
 * apps/web/src/pages/api/auth/register/start.ts for the key-building
 * convention.
 *
 * Known limitation, accepted for this MVP: KV has no atomic increment, so
 * this is a plain read-then-write. Two requests arriving at almost the
 * same instant can both read the same count and both write count+1,
 * undercounting by a small amount under concurrent abuse. A Durable
 * Object would close this race but is real scope creep for a first
 * rate-limited endpoint — revisit if abuse patterns actually exploit it.
 */
export async function checkAndIncrement(
  kv: RateLimitKv,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const current = await kv.get(key);
  const count = current === null ? 0 : Number.parseInt(current, 10);

  if (count >= limit) {
    return { allowed: false, count };
  }

  const nextCount = count + 1;
  await kv.put(key, String(nextCount), { expirationTtl: windowSeconds });
  return { allowed: true, count: nextCount };
}
