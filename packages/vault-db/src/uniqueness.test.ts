import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrated } from "./test/apply-migrations";
import { withRole } from "./test/with-role";

// Proves the partial unique index (auth_credentials_email_hash_linked_uniq)
// is the real, race-safe "duplicate email blocked" guarantee: only ONE
// *linked* (linked = true) row may exist per email hash. Multiple
// pending/unlinked rows for the same email are allowed (re-registration,
// resends). `linked` is a bare boolean, never the member_id itself — see
// schema.ts's comment on why vault-db must never be able to answer
// "which member does this email belong to".

let vaultDatabaseUrl: string;

beforeAll(() => {
  vaultDatabaseUrl = ensureMigrated();
});

async function insertRow(emailHash: string, linked: boolean): Promise<void> {
  await withRole(vaultDatabaseUrl, "vault_role", (client) =>
    client.query(
      `INSERT INTO vault.auth_credentials
         (email_hash, email_ciphertext, email_iv, pseudonym, locale, token_hash, expires_at, linked)
       VALUES ($1, 'ciphertext', 'iv', 'Pseudonym', 'ml', $2, now() + interval '15 minutes', $3)`,
      [emailHash, `token-${randomUUID()}`, linked],
    ),
  );
}

describe("auth_credentials_email_hash_linked_uniq", () => {
  it("allows multiple pending (unlinked) rows for the same email hash", async () => {
    const emailHash = `hash-pending-${randomUUID()}`;
    await insertRow(emailHash, false);
    await expect(insertRow(emailHash, false)).resolves.not.toThrow();
  });

  it("allows one linked row for an email hash but rejects a second", async () => {
    const emailHash = `hash-linked-${randomUUID()}`;
    await insertRow(emailHash, true);

    await expect(insertRow(emailHash, true)).rejects.toThrow(/duplicate key value/);
  });

  it("allows a linked row to coexist with pending rows for the same email hash", async () => {
    const emailHash = `hash-mixed-${randomUUID()}`;
    await insertRow(emailHash, false);
    await expect(insertRow(emailHash, true)).resolves.not.toThrow();
    // A second linked row is still rejected even with pending rows present.
    await expect(insertRow(emailHash, true)).rejects.toThrow(/duplicate key value/);
  });
});
