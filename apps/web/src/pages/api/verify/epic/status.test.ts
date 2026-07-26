import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it, vi } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handleStatus } from "./status";

// Issue #22 (A3 — T2 verification). handleStatus is session-authed and
// proxies to apps/vault-svc's `/internal/epic/status`. When vault-svc
// reports `approved`, this endpoint is the ONE place that flips
// packages/db's members.tier to 't2' and records the (non-identity!)
// assemblySegment/assemblySegmentCovered columns — never vault-svc itself,
// which must never write to packages/db (vault join rule, CLAUDE.md
// invariant 1/2).

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

function fakeVaultSvc(response: { status: number; body: unknown }) {
  return {
    fetch: vi.fn(
      async () => new Response(JSON.stringify(response.body), { status: response.status }),
    ),
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    VAULT_SVC: fakeVaultSvc({ status: 200, body: { status: "pending" } }),
    VAULT_SVC_INTERNAL_TOKEN: "internal-token",
    SESSION_SECRET: "session-secret",
    PILOT_CONSTITUENCY_NAME_ML: "പൈലറ്റ് മണ്ഡലം",
    PILOT_CONSTITUENCY_NAME_EN: "Pilot Constituency",
    COVERED_ASSEMBLY_SEGMENTS: "Alpha Segment,Beta Segment",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

function callStatus(
  env: ReturnType<typeof testEnv>,
  cookie?: string,
): ReturnType<typeof handleStatus> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const request = new Request("https://prajasabha.example/api/verify/epic/status", { headers });
  return handleStatus(request, env);
}

async function insertMember(
  overrides: Partial<{
    tier: "t0" | "t1" | "t2";
    assemblySegment: string | null;
    assemblySegmentCovered: boolean | null;
  }> = {},
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({
      pseudonym: `epic-status-${randomUUID().slice(0, 8)}`,
      tier: "t0",
      locale: "ml",
      ...overrides,
    })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function getMember(memberId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db.select().from(schema.members).where(eq(schema.members.memberId, memberId));
  return row;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

describe("handleStatus (GET /api/verify/epic/status)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callStatus(testEnv());
    expect(res.status).toBe(401);
  });

  it("passes a pending status through unchanged, without writing to the member row", async () => {
    const memberId = await insertMember({ tier: "t0" });
    try {
      const cookie = await sessionCookie(memberId);
      const env = testEnv({
        VAULT_SVC: fakeVaultSvc({
          status: 200,
          body: { status: "pending", assemblySegmentClaimed: "Alpha Segment", reviewedAt: null },
        }),
      });

      const res = await callStatus(env, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "pending",
        assemblySegmentClaimed: "Alpha Segment",
        reviewedAt: null,
      });

      const member = await getMember(memberId);
      expect(member?.tier).toBe("t0");
      expect(member?.assemblySegment ?? null).toBeNull();
    } finally {
      await deleteMember(memberId);
    }
  });

  it("promotes to t2 and marks assemblySegmentCovered=true for a covered assembly segment", async () => {
    const memberId = await insertMember({ tier: "t0" });
    try {
      const cookie = await sessionCookie(memberId);
      const env = testEnv({
        // Deliberately mismatched case vs. the covered-segments list —
        // proves the comparison is case-insensitive.
        COVERED_ASSEMBLY_SEGMENTS: "ALPHA SEGMENT,Beta Segment",
        VAULT_SVC: fakeVaultSvc({
          status: 200,
          body: {
            status: "approved",
            assemblySegmentClaimed: "Alpha Segment",
            reviewedAt: "2026-07-26T00:00:00.000Z",
          },
        }),
      });

      const res = await callStatus(env, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        tier: "t2",
        assemblySegment: "Alpha Segment",
        assemblySegmentCovered: true,
        status: "approved",
      });

      const member = await getMember(memberId);
      expect(member?.tier).toBe("t2");
      expect(member?.assemblySegment).toBe("Alpha Segment");
      expect(member?.assemblySegmentCovered).toBe(true);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("promotes to t2 but marks assemblySegmentCovered=false for a non-covered assembly segment", async () => {
    const memberId = await insertMember({ tier: "t0" });
    try {
      const cookie = await sessionCookie(memberId);
      const env = testEnv({
        VAULT_SVC: fakeVaultSvc({
          status: 200,
          body: {
            status: "approved",
            assemblySegmentClaimed: "Gamma Segment (not covered)",
            reviewedAt: "2026-07-26T00:00:00.000Z",
          },
        }),
      });

      const res = await callStatus(env, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tier: string; assemblySegmentCovered: boolean };
      expect(body.tier).toBe("t2");
      expect(body.assemblySegmentCovered).toBe(false);

      const member = await getMember(memberId);
      expect(member?.tier).toBe("t2");
      expect(member?.assemblySegmentCovered).toBe(false);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("is idempotent: does not overwrite an already-t2 member's assemblySegment on a repeat approved call", async () => {
    const memberId = await insertMember({
      tier: "t2",
      assemblySegment: "Original Segment",
      assemblySegmentCovered: true,
    });
    try {
      const cookie = await sessionCookie(memberId);
      const env = testEnv({
        VAULT_SVC: fakeVaultSvc({
          status: 200,
          body: {
            status: "approved",
            assemblySegmentClaimed: "A Different Segment Entirely",
            reviewedAt: "2026-07-26T00:00:00.000Z",
          },
        }),
      });

      await callStatus(env, cookie);

      const member = await getMember(memberId);
      expect(member?.tier).toBe("t2");
      // Unchanged from the original seeded value — proves no duplicate
      // write happened for an already-t2 member.
      expect(member?.assemblySegment).toBe("Original Segment");
      expect(member?.assemblySegmentCovered).toBe(true);
    } finally {
      await deleteMember(memberId);
    }
  });
});
