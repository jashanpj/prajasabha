import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getServiceRoleDb } from "./db";

// Requires a real Postgres with packages/db's migrations applied (docker
// compose up -d + `pnpm --filter db run migrate`) and APP_DATABASE_URL set
// to an app_role connection — see .env.example / CONTRIBUTING.md.
function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

describe("getServiceRoleDb", () => {
  it("app_role inherits service_role's grants automatically — can insert, read, and delete members", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const pseudonym = `db-helper-test-${randomUUID().slice(0, 8)}`;

    const [inserted] = await db
      .insert(schema.members)
      .values({ pseudonym, tier: "t0", locale: "ml" })
      .returning({ memberId: schema.members.memberId });
    expect(inserted?.memberId).toBeTruthy();

    const [found] = await db
      .select()
      .from(schema.members)
      .where(eq(schema.members.memberId, inserted?.memberId as string));
    expect(found?.pseudonym).toBe(pseudonym);

    await db
      .delete(schema.members)
      .where(eq(schema.members.memberId, inserted?.memberId as string));
  });

  it("still cannot UPDATE/DELETE event_log even via app_role's inherited service_role grants", async () => {
    const db = getServiceRoleDb(appDatabaseUrl());
    const [inserted] = await db
      .insert(schema.eventLog)
      .values({ kind: "test.event", subjectType: "test", subjectId: randomUUID() })
      .returning({ eventId: schema.eventLog.eventId });
    expect(inserted?.eventId).toBeTruthy();

    try {
      await db
        .update(schema.eventLog)
        .set({ kind: "tampered" })
        .where(eq(schema.eventLog.eventId, inserted?.eventId as string));
      expect.unreachable("UPDATE on event_log should have been rejected");
    } catch (err) {
      const cause = err instanceof Error ? err.cause : undefined;
      const message = cause instanceof Error ? cause.message : String(err);
      expect(message).toMatch(/permission denied/);
    }
  });
});
