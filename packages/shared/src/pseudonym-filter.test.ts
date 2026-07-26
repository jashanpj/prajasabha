import { describe, expect, it } from "vitest";
import { checkPseudonym } from "./pseudonym-filter";

describe("checkPseudonym", () => {
  it("allows an ordinary pseudonym", () => {
    expect(checkPseudonym("Constituent K-417")).toEqual({ allowed: true });
  });

  it("allows the canonical pseudonym copy pattern", () => {
    expect(checkPseudonym("Ward Voice 42")).toEqual({ allowed: true });
  });

  it("rejects a pseudonym under 3 characters", () => {
    expect(checkPseudonym("ab")).toEqual({ allowed: false, reason: "too-short" });
  });

  it("rejects a pseudonym over 32 characters", () => {
    expect(checkPseudonym("a".repeat(33))).toEqual({ allowed: false, reason: "too-long" });
  });

  it("rejects the placeholder profanity marker as a whole token", () => {
    expect(checkPseudonym("xxxplaceholderprofanityxxx")).toEqual({
      allowed: false,
      reason: "profanity",
    });
  });

  it("rejects the placeholder profanity marker case-insensitively and as a substring", () => {
    expect(checkPseudonym("aXXXPLACEHOLDERPROFANITYXXXa")).toEqual({
      allowed: false,
      reason: "profanity",
    });
  });

  it("rejects a party-name abbreviation", () => {
    expect(checkPseudonym("BJP Supporter")).toEqual({ allowed: false, reason: "party-name" });
  });

  it("rejects a party-name abbreviation case-insensitively", () => {
    expect(checkPseudonym("proud udf voter")).toEqual({ allowed: false, reason: "party-name" });
  });

  it("does not flag a clean pseudonym that merely contains short common substrings", () => {
    // Guards against an overly broad denylist entry accidentally matching
    // ordinary words.
    expect(checkPseudonym("Riverside Reader")).toEqual({ allowed: true });
  });
});
