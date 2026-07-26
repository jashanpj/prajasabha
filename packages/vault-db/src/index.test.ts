import { describe, expect, it } from "vitest";
import { createVaultDbClient, schema } from "./index";

describe("packages/vault-db entrypoint", () => {
  it("exports the vault schema object, auth_credentials (issue #20), and epic_verifications (issue #16)", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "authCredentials",
      "epicVerificationStatusEnum",
      "epicVerifications",
      "vault",
    ]);
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createVaultDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_vault_test"),
    ).not.toThrow();
  });
});
