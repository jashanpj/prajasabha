import { describe, expect, it } from "vitest";
import { createVaultDbClient, schema } from "./index";

describe("packages/vault-db entrypoint", () => {
  it("exports an empty schema (no tables until #16)", () => {
    expect(Object.keys(schema)).toEqual([]);
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createVaultDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_vault_test"),
    ).not.toThrow();
  });
});
