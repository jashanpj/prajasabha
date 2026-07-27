import { randomUUID } from "node:crypto";
import { schema } from "db";
import { beforeAll, describe, expect, it } from "vitest";
import { getServiceRoleDb } from "./db";
import { type IssueListFilters, listIssues, parseIssueFilters } from "./issue-list";

// B6 — public issue browse (issue #105). Two units under test:
//
//  - parseIssueFilters: pure. Validates ward/category/status query params
//    against the pilot's config allow-lists. Anything unrecognised is
//    DROPPED, never forwarded to the query.
//  - listIssues: the DB query. This page reads via service_role, which RLS
//    does not gate, so `status = 'published'` in application logic is the
//    ONLY thing keeping drafts off a public index. That guard gets its own
//    tests below — a `?status=draft` in the URL must not widen visibility.
//
// Real Postgres (APP_DATABASE_URL), no mocked DB — same convention as
// router.test.ts and every endpoint test in this app.

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set — see CONTRIBUTING.md for the local test-database setup.",
    );
  }
  return url;
}

const db = getServiceRoleDb(appDatabaseUrl());

const WARD_A = randomUUID();
const WARD_B = randomUUID();
const ALLOWED_CATEGORIES = ["roads", "water"];

// One member owns every fixture issue (issues.created_by is NOT NULL and
// FK-references members).
let authorMemberId: string;

async function insertIssue(overrides: {
  slug: string;
  status: "draft" | "published" | "merged" | "closed";
  category: string;
  wardId: string;
  supportT2Count?: number;
  promotedAt?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.issues)
    .values({
      slug: overrides.slug,
      titleMl: `ml ${overrides.slug}`,
      titleEn: `en ${overrides.slug}`,
      body: "fixture body",
      category: overrides.category,
      wardId: overrides.wardId,
      status: overrides.status,
      supportT2Count: overrides.supportT2Count ?? 0,
      promotedAt: overrides.promotedAt ?? null,
      createdBy: authorMemberId,
    })
    .returning({ issueId: schema.issues.issueId });
  return row?.issueId as string;
}

const run = randomUUID().slice(0, 8);

beforeAll(async () => {
  const [member] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-list-${run}`, tier: "t2", locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  authorMemberId = member?.memberId as string;

  await insertIssue({
    slug: `il-${run}-published-roads-a`,
    status: "published",
    category: "roads",
    wardId: WARD_A,
    supportT2Count: 10,
  });
  await insertIssue({
    slug: `il-${run}-published-water-b`,
    status: "published",
    category: "water",
    wardId: WARD_B,
    supportT2Count: 30,
  });
  await insertIssue({
    slug: `il-${run}-concern-roads-b`,
    status: "published",
    category: "roads",
    wardId: WARD_B,
    supportT2Count: 120,
    promotedAt: new Date(),
  });
  await insertIssue({
    slug: `il-${run}-draft-roads-a`,
    status: "draft",
    category: "roads",
    wardId: WARD_A,
  });
  await insertIssue({
    slug: `il-${run}-merged-roads-a`,
    status: "merged",
    category: "roads",
    wardId: WARD_A,
  });
  await insertIssue({
    slug: `il-${run}-closed-roads-a`,
    status: "closed",
    category: "roads",
    wardId: WARD_A,
  });
});

// Scope every assertion to this run's fixtures — the shared test database
// carries rows from other suites.
async function slugsFor(filters: IssueListFilters): Promise<string[]> {
  const { rows } = await listIssues(db, filters, { limit: 50, page: 1 });
  return rows.filter((r) => r.slug.startsWith(`il-${run}-`)).map((r) => r.slug);
}

const allowLists = { wardIds: [WARD_A, WARD_B], categories: ALLOWED_CATEGORIES };

describe("parseIssueFilters", () => {
  it("defaults to the 'all' status and no ward/category filter", () => {
    const filters = parseIssueFilters(new URLSearchParams(), allowLists);
    expect(filters).toEqual({ ward: null, category: null, status: "all" });
  });

  it("accepts ward, category and status values that are on the allow-lists", () => {
    const filters = parseIssueFilters(
      new URLSearchParams({ ward: WARD_B, category: "water", status: "concern" }),
      allowLists,
    );
    expect(filters).toEqual({ ward: WARD_B, category: "water", status: "concern" });
  });

  it("drops a ward that is not in the pilot's ward allow-list", () => {
    const filters = parseIssueFilters(new URLSearchParams({ ward: randomUUID() }), allowLists);
    expect(filters.ward).toBeNull();
  });

  it("drops a category that is not in the configured category allow-list", () => {
    const filters = parseIssueFilters(new URLSearchParams({ category: "sewage" }), allowLists);
    expect(filters.category).toBeNull();
  });

  it("drops a non-uuid ward without throwing", () => {
    const filters = parseIssueFilters(new URLSearchParams({ ward: "'; drop table" }), allowLists);
    expect(filters.ward).toBeNull();
  });

  // The security-relevant case: `draft`/`closed`/`merged` are real
  // issue_status enum values, so a caller could plausibly expect them to
  // work as filter values. They must never be accepted.
  it.each(["draft", "closed", "merged", "", "ALL", "published"])(
    "coerces the non-public status %j back to 'all'",
    (status) => {
      const filters = parseIssueFilters(new URLSearchParams({ status }), allowLists);
      expect(filters.status).toBe("all");
    },
  );
});

describe("listIssues", () => {
  it("returns only published issues — never draft, closed or merged", async () => {
    const slugs = await slugsFor({ ward: null, category: null, status: "all" });
    expect(slugs).toEqual(
      expect.arrayContaining([
        `il-${run}-published-roads-a`,
        `il-${run}-published-water-b`,
        `il-${run}-concern-roads-b`,
      ]),
    );
    expect(slugs).not.toContain(`il-${run}-draft-roads-a`);
    expect(slugs).not.toContain(`il-${run}-merged-roads-a`);
    expect(slugs).not.toContain(`il-${run}-closed-roads-a`);
  });

  // Defence in depth: even if a caller bypasses parseIssueFilters and hands
  // listIssues a forged status, the query's own predicate must still pin
  // visibility to published.
  it("does not surface drafts even when handed a forged status value", async () => {
    const slugs = await slugsFor({
      ward: null,
      category: null,
      status: "draft" as unknown as IssueListFilters["status"],
    });
    expect(slugs).not.toContain(`il-${run}-draft-roads-a`);
    expect(slugs).not.toContain(`il-${run}-closed-roads-a`);
  });

  it("filters by ward", async () => {
    const slugs = await slugsFor({ ward: WARD_B, category: null, status: "all" });
    expect(slugs.sort()).toEqual([`il-${run}-concern-roads-b`, `il-${run}-published-water-b`]);
  });

  it("filters by category", async () => {
    const slugs = await slugsFor({ ward: null, category: "water", status: "all" });
    expect(slugs).toEqual([`il-${run}-published-water-b`]);
  });

  it("combines ward and category filters", async () => {
    const slugs = await slugsFor({ ward: WARD_B, category: "roads", status: "all" });
    expect(slugs).toEqual([`il-${run}-concern-roads-b`]);
  });

  it("status=concern returns only promoted issues", async () => {
    const slugs = await slugsFor({ ward: null, category: null, status: "concern" });
    expect(slugs).toEqual([`il-${run}-concern-roads-b`]);
  });

  it("status=open returns only published issues that are not yet promoted", async () => {
    const slugs = await slugsFor({ ward: null, category: null, status: "open" });
    expect(slugs).toEqual(
      expect.arrayContaining([`il-${run}-published-roads-a`, `il-${run}-published-water-b`]),
    );
    expect(slugs).not.toContain(`il-${run}-concern-roads-b`);
  });

  it("orders by verified support, descending", async () => {
    const slugs = await slugsFor({ ward: null, category: null, status: "all" });
    expect(slugs).toEqual([
      `il-${run}-concern-roads-b`,
      `il-${run}-published-water-b`,
      `il-${run}-published-roads-a`,
    ]);
  });

  it("paginates and reports a total independent of the page", async () => {
    const filters: IssueListFilters = { ward: WARD_B, category: null, status: "all" };
    const firstPage = await listIssues(db, filters, { limit: 1, page: 1 });
    const secondPage = await listIssues(db, filters, { limit: 1, page: 2 });

    expect(firstPage.rows).toHaveLength(1);
    expect(secondPage.rows).toHaveLength(1);
    expect(firstPage.rows[0]?.slug).not.toBe(secondPage.rows[0]?.slug);
    expect(firstPage.total).toBe(2);
    expect(secondPage.total).toBe(2);
    expect(firstPage.pageCount).toBe(2);
    expect(firstPage.page).toBe(1);
    expect(secondPage.page).toBe(2);
  });

  // `page` arrives straight from a public URL. Without an upper clamp,
  // a large value overflows the OFFSET parameter and 500s the route, and
  // a merely-huge one forces a deep scan on an anonymous request. Both
  // must land on the last real page instead.
  it.each([
    ["above the last page", 9999],
    ["absurdly large", 1e21],
    ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("clamps a %s page down to the last page", async (_label, page) => {
    const filters: IssueListFilters = { ward: WARD_B, category: null, status: "all" };
    const result = await listIssues(db, filters, { limit: 1, page });

    expect(result.pageCount).toBe(2);
    expect(result.page).toBe(2);
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["fractional", 1.7],
  ])("clamps a %s page up to the first page", async (_label, page) => {
    const filters: IssueListFilters = { ward: WARD_B, category: null, status: "all" };
    const result = await listIssues(db, filters, { limit: 1, page });

    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("reports pageCount 1 and page 1 when nothing matches", async () => {
    const result = await listIssues(
      db,
      { ward: randomUUID(), category: null, status: "all" },
      { limit: 20, page: 5 },
    );
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
  });

  it("returns the responsible authority for each issue without an N+1 query", async () => {
    const [authority] = await db
      .insert(schema.authorities)
      .values({ kind: "councillor", nameMl: `ml-auth-${run}`, nameEn: `en-auth-${run}` })
      .returning({ authorityId: schema.authorities.authorityId });

    const issueId = await insertIssue({
      slug: `il-${run}-routed`,
      status: "published",
      category: "roads",
      wardId: WARD_A,
      supportT2Count: 5,
    });
    await db.insert(schema.routings).values({
      issueId,
      authorityId: authority?.authorityId as string,
      role: "responsible",
      legalBasisRef: null,
    });

    const { rows } = await listIssues(
      db,
      { ward: WARD_A, category: "roads", status: "all" },
      { limit: 50, page: 1 },
    );
    const routed = rows.find((r) => r.slug === `il-${run}-routed`);
    expect(routed?.responsibleAuthority).toEqual({
      nameMl: `ml-auth-${run}`,
      nameEn: `en-auth-${run}`,
    });
  });

  it("leaves responsibleAuthority null for an issue with no routing", async () => {
    const { rows } = await listIssues(
      db,
      { ward: null, category: "water", status: "all" },
      { limit: 50, page: 1 },
    );
    const unrouted = rows.find((r) => r.slug === `il-${run}-published-water-b`);
    expect(unrouted?.responsibleAuthority).toBeNull();
  });

  it("returns an empty page and a zero total when nothing matches", async () => {
    const result = await listIssues(
      db,
      { ward: randomUUID(), category: null, status: "all" },
      { limit: 50, page: 1 },
    );
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});
