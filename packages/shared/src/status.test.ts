import { describe, expect, it } from "vitest";
import {
  STATUS_ACKNOWLEDGED,
  STATUS_ACTED_UPON,
  STATUS_DELIVERED,
  statusNoResponse,
} from "./status";

// Asserts against CLAUDE.md's product-law section verbatim, per issue #17's
// test notes. Codepoint checks (not just string equality) guard against a
// straight-hyphen/ASCII substitution regression that `toBe` alone could
// pass if someone "helpfully" retyped the glyph with a look-alike char.
describe("status.ts (product law, verbatim)", () => {
  it("STATUS_DELIVERED matches exactly", () => {
    expect(STATUS_DELIVERED).toBe("Delivered");
  });

  it("STATUS_ACKNOWLEDGED matches exactly, including the → glyph", () => {
    expect(STATUS_ACKNOWLEDGED).toBe("→ Acknowledged");
    expect(STATUS_ACKNOWLEDGED.codePointAt(0)).toBe(0x2192);
  });

  it("STATUS_ACTED_UPON matches exactly, including the ✓ glyph", () => {
    expect(STATUS_ACTED_UPON).toBe("✓ Acted upon");
    expect(STATUS_ACTED_UPON.codePointAt(0)).toBe(0x2713);
  });

  it("statusNoResponse interpolates the day count with the exact literal wording", () => {
    expect(statusNoResponse(84)).toBe("– No response — 84 days");
    expect(statusNoResponse(84).codePointAt(0)).toBe(0x2013); // en dash, not a hyphen
  });
});
