import { describe, expect, it } from "vitest";
import { createVaultDbClient, schema } from "./index";

describe("packages/vault-db entrypoint", () => {
  it("exports the vault schema object and the auth_credentials table (issue #20)", () => {
    expect(Object.keys(schema).sort()).toEqual(["authCredentials", "vault"]);
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createVaultDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_vault_test"),
    ).not.toThrow();
  });
});
