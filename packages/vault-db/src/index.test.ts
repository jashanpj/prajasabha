import { describe, expect, it } from "vitest";
import { createVaultDbClient, schema } from "./index";

describe("packages/vault-db entrypoint", () => {
  // Deliberately an exact-match allow-list, not a `toContain`: the vault's
  // surface is the thing invariant 1 constrains, so a new table here should
  // fail this test and force a conscious decision rather than slipping in.
  it("exports the vault schema object, auth_credentials (issue #20), epic_verifications (issue #16), and access_log (issue #23)", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "accessLog",
      "authCredentials",
      "epicVerificationStatusEnum",
      "epicVerifications",
      "vault",
      "vaultAccessCallerEnum",
      "vaultAccessOperationEnum",
      "vaultAccessOutcomeEnum",
    ]);
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createVaultDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_vault_test"),
    ).not.toThrow();
  });
});
