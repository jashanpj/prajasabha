import { describe, expect, it } from "vitest";
import { createDbClient, schema } from "./index";

describe("packages/db entrypoint", () => {
  it("exports an empty schema (no tables until #15)", () => {
    expect(Object.keys(schema)).toEqual([]);
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_test"),
    ).not.toThrow();
  });
});
