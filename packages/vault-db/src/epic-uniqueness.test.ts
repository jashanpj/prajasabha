import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// Proves the partial unique index (epic_verifications_hash_approved_uniq)
// is the real, race-safe "one EPIC number = one account" guarantee (issue
// #22's AC): only ONE *approved* row may exist per EPIC-number hash.
// Multiple pending/rejected rows for the same hash are still allowed
// (resubmission after rejection, concurrent review).

let vaultDatabaseUrl: string;

beforeAll(() => {
  vaultDatabaseUrl = ensureMigrated();
});

async function insertRow(
  epicNumberHash: string,
  status: "pending" | "approved" | "rejected",
): Promise<void> {
  await withRole(vaultDatabaseUrl, "vault_role", (client) =>
    client.query(
      `INSERT INTO vault.epic_verifications
         (epic_number_hash, epic_number_ciphertext, epic_number_iv, doc_ciphertext, doc_iv, assembly_segment_claimed, status)
       VALUES ($1, 'ciphertext', 'iv', 'doc-ciphertext', 'doc-iv', 'Some Assembly Segment', $2)`,
      [epicNumberHash, status],
    ),
  );
}

describe("epic_verifications_hash_approved_uniq", () => {
  it("allows multiple pending rows for the same EPIC-number hash", async () => {
    const epicNumberHash = `hash-pending-${randomUUID()}`;
    await insertRow(epicNumberHash, "pending");
    await expect(insertRow(epicNumberHash, "pending")).resolves.not.toThrow();
  });

  it("allows one approved row for an EPIC-number hash but rejects a second", async () => {
    const epicNumberHash = `hash-approved-${randomUUID()}`;
    await insertRow(epicNumberHash, "approved");
    await expect(insertRow(epicNumberHash, "approved")).rejects.toThrow(/duplicate key value/);
  });

  it("allows an approved row to coexist with pending rows for the same EPIC-number hash", async () => {
    const epicNumberHash = `hash-mixed-${randomUUID()}`;
    await insertRow(epicNumberHash, "pending");
    await expect(insertRow(epicNumberHash, "approved")).resolves.not.toThrow();
    await expect(insertRow(epicNumberHash, "approved")).rejects.toThrow(/duplicate key value/);
  });
});
