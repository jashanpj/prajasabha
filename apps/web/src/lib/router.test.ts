import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "./db";
import { computeRouting } from "./router";

// Issue #25 (B2 — Responsibility Router, multi-authority). computeRouting
// queries the new routing_rules table for (category, wardId) OR
// (category, wardId IS NULL) matches and returns one
// {authorityId, role, legalBasisRef} per matched authority. Per the
// approved plan: wardId NULL on a rule means "every ward in the pilot",
// and when a ward-specific rule and a wildcard rule both exist for the
// SAME authorityId+category, the ward-specific one wins (deduped) — never
// two entries for one authority. This file covers exactly the two cases
// the issue's test notes require ("at least one multi-authority (fan-out)
// case and one copied-for-information case"), plus the no-match and
// dedup edge cases the design decisions call out. Real Postgres
// (APP_DATABASE_URL) — no mocked DB, same convention as every endpoint
// test in this app.

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

const WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function uniqueCategory(label: string): string {
  return `router-test-${label}-${randomUUID().slice(0, 8)}`;
}

async function insertAuthority(
  kind: "councillor" | "ulb" | "mla" | "mp" | "dept" | "agency",
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const suffix = randomUUID().slice(0, 8);
  const [inserted] = await db
    .insert(schema.authorities)
    .values({ kind, nameMl: `അതോറിറ്റി ${suffix}`, nameEn: `Authority ${suffix}` })
    .returning({ authorityId: schema.authorities.authorityId });
  if (!inserted) throw new Error("authority insert returned no row");
  return inserted.authorityId;
}

async function insertRoutingRule(fields: {
  category: string;
  wardId: string | null;
  authorityId: string;
  role: "responsible" | "copied";
  legalBasisRef?: string | null;
}): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.insert(schema.routingRules).values({
    category: fields.category,
    wardId: fields.wardId,
    authorityId: fields.authorityId,
    role: fields.role,
    legalBasisRef: fields.legalBasisRef ?? null,
  });
}

async function cleanupAuthority(authorityId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.routingRules).where(eq(schema.routingRules.authorityId, authorityId));
  await db.delete(schema.authorities).where(eq(schema.authorities.authorityId, authorityId));
}

describe("computeRouting", () => {
  it("returns an empty array when no routing_rules row matches the category", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const category = uniqueCategory("no-match");

    const result = await computeRouting(db, { category, wardId: WARD_ID });

    expect(result).toEqual([]);
  });

  it("fans out to multiple authorities: a ward-specific Councillor rule AND a wildcard ULB rule for the same category", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const category = uniqueCategory("fanout");
    const councillorId = await insertAuthority("councillor");
    const ulbId = await insertAuthority("ulb");

    try {
      await insertRoutingRule({
        category,
        wardId: WARD_ID,
        authorityId: councillorId,
        role: "responsible",
        legalBasisRef: "kerala-panchayat-raj-act-1994",
      });
      await insertRoutingRule({
        category,
        wardId: null,
        authorityId: ulbId,
        role: "responsible",
        legalBasisRef: "kerala-municipality-act-1994",
      });

      const result = await computeRouting(db, { category, wardId: WARD_ID });

      expect(result).toHaveLength(2);
      const authorityIds = result.map((r) => r.authorityId).sort();
      expect(authorityIds).toEqual([councillorId, ulbId].sort());
      for (const routing of result) {
        expect(routing.role).toBe("responsible");
      }
    } finally {
      await cleanupAuthority(councillorId);
      await cleanupAuthority(ulbId);
    }
  });

  it("preserves distinct roles: an MP wildcard 'copied' rule alongside a 'responsible' rule for the same category", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const category = uniqueCategory("copied");
    const mpId = await insertAuthority("mp");
    const ulbId = await insertAuthority("ulb");

    try {
      await insertRoutingRule({
        category,
        wardId: null,
        authorityId: mpId,
        role: "copied",
        legalBasisRef: null,
      });
      await insertRoutingRule({
        category,
        wardId: null,
        authorityId: ulbId,
        role: "responsible",
        legalBasisRef: "kerala-municipality-act-1994",
      });

      const result = await computeRouting(db, { category, wardId: WARD_ID });

      expect(result).toHaveLength(2);
      const mpRouting = result.find((r) => r.authorityId === mpId);
      const ulbRouting = result.find((r) => r.authorityId === ulbId);
      expect(mpRouting?.role).toBe("copied");
      expect(ulbRouting?.role).toBe("responsible");
    } finally {
      await cleanupAuthority(mpId);
      await cleanupAuthority(ulbId);
    }
  });

  it("dedupes a ward-specific rule against a wildcard rule for the SAME authority+category — ward-specific wins", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const category = uniqueCategory("dedup");
    const authorityId = await insertAuthority("councillor");

    try {
      await insertRoutingRule({
        category,
        wardId: WARD_ID,
        authorityId,
        role: "responsible",
        legalBasisRef: "ward-specific-ref",
      });
      await insertRoutingRule({
        category,
        wardId: null,
        authorityId,
        role: "responsible",
        legalBasisRef: "wildcard-ref",
      });

      const result = await computeRouting(db, { category, wardId: WARD_ID });

      const matches = result.filter((r) => r.authorityId === authorityId);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.legalBasisRef).toBe("ward-specific-ref");
    } finally {
      await cleanupAuthority(authorityId);
    }
  });
});
