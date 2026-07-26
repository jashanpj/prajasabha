import { describe, expect, it } from "vitest";
import { createDbClient, schema } from "./index";

describe("packages/db entrypoint", () => {
  it("exports the 7 core participation tables and their enums", () => {
    expect(Object.keys(schema).sort()).toEqual(
      [
        "authorities",
        "authorityKindEnum",
        "eventLog",
        "issueStatusEnum",
        "issueSupport",
        "issues",
        "localeEnum",
        "memberTierEnum",
        "members",
        "moderationActions",
        "routingRoleEnum",
        "routings",
      ].sort(),
    );
  });

  it("creates a client without touching the network", () => {
    expect(() =>
      createDbClient("postgres://postgres:postgres@localhost:5432/prajasabha_test"),
    ).not.toThrow();
  });
});
