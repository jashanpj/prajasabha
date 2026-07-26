import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "./auth";

/**
 * Gate for `/review/epic/*` (issue #22 — A3 T2 verification): the
 * human-reviewer queue, deliberately a *different* threat model and auth
 * path from `requireInternalToken`'s service-to-service `/internal/*`
 * routes — a leaked review-queue token must not grant `/internal/*`
 * access, and vice versa. Two independent factors are required: the
 * correct bearer token AND an allow-listed `CF-Connecting-IP` (HLD §4.3:
 * "separate origin, separate auth, IP-allowlisted").
 */
export function requireReviewAccess(
  expectedToken: string,
  allowedIps: string[],
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const ip = c.req.header("CF-Connecting-IP");

    if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!ip || !allowedIps.includes(ip)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}
