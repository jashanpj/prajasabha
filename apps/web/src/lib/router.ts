import { schema } from "db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { getServiceRoleDb } from "./db";

// B2 — Responsibility Router (issue #25). Matches an issue's
// (category, wardId) against the routing_rules table (HLD §6's "SQL rules
// table, category×ward→authorities, editable in admin"). A rule with
// wardId NULL applies to every ward in this single-constituency pilot; a
// concrete wardId scopes a rule to that ward only (e.g. one row per ward's
// Councillor). When both a ward-specific and a wildcard rule exist for the
// SAME authority+category, the ward-specific one wins — an authority never
// appears twice in the result for one issue.
export interface RoutingMatch {
  authorityId: string;
  role: "responsible" | "copied";
  legalBasisRef: string | null;
}

export async function computeRouting(
  db: ReturnType<typeof getServiceRoleDb>,
  { category, wardId }: { category: string; wardId: string },
): Promise<RoutingMatch[]> {
  const rules = await db
    .select({
      authorityId: schema.routingRules.authorityId,
      role: schema.routingRules.role,
      legalBasisRef: schema.routingRules.legalBasisRef,
      wardId: schema.routingRules.wardId,
    })
    .from(schema.routingRules)
    .where(
      and(
        eq(schema.routingRules.category, category),
        or(eq(schema.routingRules.wardId, wardId), isNull(schema.routingRules.wardId)),
      ),
    );

  // Ward-specific rows take precedence over a wildcard row for the same
  // authority — a Map keyed by authorityId naturally dedupes, and
  // iterating ward-specific rows last lets them overwrite any wildcard
  // entry already present.
  const byAuthority = new Map<string, RoutingMatch>();
  for (const rule of rules.filter((r) => r.wardId === null)) {
    byAuthority.set(rule.authorityId, {
      authorityId: rule.authorityId,
      role: rule.role,
      legalBasisRef: rule.legalBasisRef,
    });
  }
  for (const rule of rules.filter((r) => r.wardId !== null)) {
    byAuthority.set(rule.authorityId, {
      authorityId: rule.authorityId,
      role: rule.role,
      legalBasisRef: rule.legalBasisRef,
    });
  }

  return Array.from(byAuthority.values());
}
