import { schema } from "db";
import { type SQL, and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { getServiceRoleDb } from "./db";

// B6 — public issue browse (issue #105). The query + filter-validation half
// of `/issues`, kept out of the .astro page so it can be unit-tested: no
// vitest test can render an Astro page in this repo (see apps/web/
// vitest.config.ts's note on the astro/vite version conflict), so anything
// that needs real coverage has to live in a plain .ts module. Same split as
// router.ts/router.test.ts.
//
// SECURITY: `/issues` reads through a service_role connection, which RLS
// does NOT gate. The `status = 'published'` predicate in listIssues is
// therefore the only thing keeping drafts and closed issues off a public,
// unauthenticated index — it is deliberately hard-coded into the base
// predicate rather than derived from the caller's filters, so no query
// param can widen it. parseIssueFilters is the second layer, not the only
// one; both are covered in issue-list.test.ts.

/**
 * Publicly selectable views over the published set. Deliberately NOT the
 * `issue_status` enum: `draft`/`closed` are not public at all, and `merged`
 * issues are reachable by direct link (B3 keeps both threads' history) but
 * are not listed on the index, since a merged thread's support has already
 * moved to its target and listing it would double-count the same concern.
 *
 *  - `all`     — every published issue
 *  - `concern` — published AND promoted past the concern threshold (B4)
 *  - `open`    — published but not yet promoted
 */
export type IssueListStatus = "all" | "concern" | "open";

const PUBLIC_STATUSES: readonly IssueListStatus[] = ["all", "concern", "open"];

export interface IssueListFilters {
  ward: string | null;
  category: string | null;
  status: IssueListStatus;
}

export interface IssueListAllowLists {
  wardIds: string[];
  categories: string[];
}

export interface IssueListPage {
  limit: number;
  /** 1-based. Clamped internally to [1, pageCount] — see listIssues. */
  page: number;
}

export interface IssueListRow {
  issueId: string;
  slug: string;
  titleMl: string;
  titleEn: string;
  category: string;
  wardId: string;
  supportT2Count: number;
  promotedAt: Date | null;
  responsibleAuthority: { nameMl: string; nameEn: string } | null;
}

export interface IssueListResult {
  rows: IssueListRow[];
  total: number;
  /** The page actually served, after clamping. */
  page: number;
  pageCount: number;
}

/**
 * Validates raw query params against the pilot's configured allow-lists.
 * Anything unrecognised is dropped (null / "all") rather than rejected —
 * a stale or hand-edited URL should degrade to a wider view, not a 400.
 */
export function parseIssueFilters(
  searchParams: URLSearchParams,
  allowLists: IssueListAllowLists,
): IssueListFilters {
  const rawWard = searchParams.get("ward");
  const rawCategory = searchParams.get("category");
  const rawStatus = searchParams.get("status");

  const ward = rawWard && allowLists.wardIds.includes(rawWard) ? rawWard : null;
  const category = rawCategory && allowLists.categories.includes(rawCategory) ? rawCategory : null;
  const status = PUBLIC_STATUSES.includes(rawStatus as IssueListStatus)
    ? (rawStatus as IssueListStatus)
    : "all";

  return { ward, category, status };
}

function buildPredicate(filters: IssueListFilters): SQL | undefined {
  // Always first, never caller-controlled — see the SECURITY note above.
  const conditions: (SQL | undefined)[] = [eq(schema.issues.status, "published")];

  if (filters.ward) conditions.push(eq(schema.issues.wardId, filters.ward));
  if (filters.category) conditions.push(eq(schema.issues.category, filters.category));
  if (filters.status === "concern") conditions.push(isNotNull(schema.issues.promotedAt));
  if (filters.status === "open") conditions.push(isNull(schema.issues.promotedAt));

  return and(...conditions);
}

/**
 * One page of published issues, ordered by verified support (the same
 * ranking the dashboard's "Constituency concerns" list uses), plus the
 * total matching count for pagination.
 *
 * The requested page is CLAMPED to [1, pageCount] before it becomes an
 * OFFSET. `page` arrives straight from a public URL, so without the clamp
 * a caller could push the offset past int8 range (Postgres then rejects
 * the parameter and the page 500s) or force an arbitrarily deep scan plus
 * count(*) on an anonymous request. Hence count-then-fetch ordering: the
 * total is what bounds the offset.
 *
 * The responsible-authority lookup is a single batched query keyed by the
 * page's issue ids, mirroring dashboard.astro — never one query per row.
 */
export async function listIssues(
  db: ReturnType<typeof getServiceRoleDb>,
  filters: IssueListFilters,
  page: IssueListPage,
): Promise<IssueListResult> {
  const predicate = buildPredicate(filters);
  const limit = Math.max(1, Math.trunc(page.limit));

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.issues)
    .where(predicate);
  const total = totalRow?.total ?? 0;

  const pageCount = Math.max(1, Math.ceil(total / limit));
  // NaN means "unparseable" and belongs on page 1. Everything else — including
  // Infinity and values far past int8 — is first pinned into safe-integer
  // range, then clamped to the last real page, so OFFSET is always a small
  // int a caller cannot influence beyond pageCount.
  const requested = Number.isNaN(page.page)
    ? 1
    : Math.trunc(Math.min(Math.max(page.page, 1), Number.MAX_SAFE_INTEGER));
  const currentPage = Math.min(requested, pageCount);

  if (total === 0) return { rows: [], total, page: currentPage, pageCount };

  const rows = await db
    .select({
      issueId: schema.issues.issueId,
      slug: schema.issues.slug,
      titleMl: schema.issues.titleMl,
      titleEn: schema.issues.titleEn,
      category: schema.issues.category,
      wardId: schema.issues.wardId,
      supportT2Count: schema.issues.supportT2Count,
      promotedAt: schema.issues.promotedAt,
    })
    .from(schema.issues)
    .where(predicate)
    .orderBy(desc(schema.issues.supportT2Count), desc(schema.issues.issueId))
    .limit(limit)
    .offset((currentPage - 1) * limit);

  if (rows.length === 0) return { rows: [], total, page: currentPage, pageCount };

  const routingRows = await db
    .select({
      issueId: schema.routings.issueId,
      authorityNameMl: schema.authorities.nameMl,
      authorityNameEn: schema.authorities.nameEn,
    })
    .from(schema.routings)
    .innerJoin(schema.authorities, eq(schema.routings.authorityId, schema.authorities.authorityId))
    .where(
      and(
        eq(schema.routings.role, "responsible"),
        inArray(
          schema.routings.issueId,
          rows.map((row) => row.issueId),
        ),
      ),
    );

  const authorityByIssue = new Map<string, { nameMl: string; nameEn: string }>();
  for (const row of routingRows) {
    if (!authorityByIssue.has(row.issueId)) {
      authorityByIssue.set(row.issueId, {
        nameMl: row.authorityNameMl,
        nameEn: row.authorityNameEn,
      });
    }
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      responsibleAuthority: authorityByIssue.get(row.issueId) ?? null,
    })),
    total,
    page: currentPage,
    pageCount,
  };
}
