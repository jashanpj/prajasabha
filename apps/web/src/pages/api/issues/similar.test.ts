import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "../../../lib/db";
import { handleSimilar } from "./similar";

// Issue #26 (B3 — Support & Dedup). GET /api/issues/similar?titleEn=&category=
// is a deliberately unranked, unauthed "ship a reasonable first pass" nudge
// (approved plan) — an ILIKE substring match against PUBLISHED issues'
// titleEn within the same category, capped to 3 results, no pg_trgm/ranking
// model. No session required: it only reads data that's already public
// (published issues). Returns a plain JSON array of matches (each carrying
// at minimum issueId/slug/titleEn — enough for #24's new.astro to link to
// the match — see the approved plan's "Wired into pages/issues/new.astro"
// note), or [] when nothing matches (not an error).

const ALLOWED_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function insertMember(): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-similar-${randomUUID().slice(0, 8)}`, tier: "t1", locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

async function insertIssue(
  createdBy: string,
  overrides: Partial<{
    status: "draft" | "published" | "merged" | "closed";
    titleEn: string;
    category: string;
  }> = {},
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: `issue-similar-test-${randomUUID().slice(0, 8)}`,
      titleMl: "ml title",
      titleEn: overrides.titleEn ?? "Broken streetlight near the market",
      body: "body text",
      category: overrides.category ?? "electricity",
      wardId: ALLOWED_WARD_ID,
      status: overrides.status ?? "published",
      createdBy,
    })
    .returning({ issueId: schema.issues.issueId });
  if (!inserted) throw new Error("issue insert returned no row");
  return inserted.issueId;
}

async function deleteIssue(issueId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.issues).where(eq(schema.issues.issueId, issueId));
}

function callSimilar(
  env: ReturnType<typeof testEnv>,
  titleEn: string,
  category: string,
): ReturnType<typeof handleSimilar> {
  const url = new URL("https://prajasabha.example/api/issues/similar");
  url.searchParams.set("titleEn", titleEn);
  url.searchParams.set("category", category);
  const request = new Request(url, { method: "GET" });
  return handleSimilar(request, env);
}

describe("handleSimilar (GET /api/issues/similar)", () => {
  it("matches only published issues whose titleEn contains the query substring (case-insensitive) in the given category", async () => {
    const memberId = await insertMember();
    let publishedId: string | undefined;
    let draftId: string | undefined;
    try {
      publishedId = await insertIssue(memberId, {
        titleEn: "Broken Streetlight near the market",
        category: "electricity",
        status: "published",
      });
      draftId = await insertIssue(memberId, {
        titleEn: "Broken streetlight on main road",
        category: "electricity",
        status: "draft",
      });

      const res = await callSimilar(testEnv(), "streetlight", "electricity");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ issueId: string }>;
      const ids = body.map((m) => m.issueId);
      expect(ids).toContain(publishedId);
      expect(ids).not.toContain(draftId);
    } finally {
      if (publishedId) await deleteIssue(publishedId);
      if (draftId) await deleteIssue(draftId);
      await deleteMember(memberId);
    }
  });

  it("excludes issues whose titleEn matches but whose category differs", async () => {
    const memberId = await insertMember();
    let sameCategoryId: string | undefined;
    let otherCategoryId: string | undefined;
    try {
      sameCategoryId = await insertIssue(memberId, {
        titleEn: "Overflowing garbage bin on 3rd street",
        category: "sanitation",
        status: "published",
      });
      otherCategoryId = await insertIssue(memberId, {
        titleEn: "Overflowing garbage bin near the school",
        category: "roads",
        status: "published",
      });

      const res = await callSimilar(testEnv(), "garbage", "sanitation");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ issueId: string }>;
      const ids = body.map((m) => m.issueId);
      expect(ids).toContain(sameCategoryId);
      expect(ids).not.toContain(otherCategoryId);
    } finally {
      if (sameCategoryId) await deleteIssue(sameCategoryId);
      if (otherCategoryId) await deleteIssue(otherCategoryId);
      await deleteMember(memberId);
    }
  });

  it("caps results at 3 even when more matching published issues exist", async () => {
    const memberId = await insertMember();
    const issueIds: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        issueIds.push(
          await insertIssue(memberId, {
            titleEn: `Water logging near junction ${i}`,
            category: "water",
            status: "published",
          }),
        );
      }

      const res = await callSimilar(testEnv(), "water logging", "water");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ issueId: string }>;
      expect(body.length).toBe(3);
    } finally {
      for (const id of issueIds) await deleteIssue(id);
      await deleteMember(memberId);
    }
  });

  it("returns an empty array (not an error) when nothing matches", async () => {
    const res = await callSimilar(testEnv(), `no-such-title-${randomUUID()}`, "roads");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
