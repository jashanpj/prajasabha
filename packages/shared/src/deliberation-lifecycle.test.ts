import { describe, expect, it } from "vitest";
import {
  DELIBERATION_STATES,
  type DeliberationState,
  InvalidDeliberationTransitionError,
  assertValidDeliberationTransition,
  isValidDeliberationTransition,
} from "./deliberation-lifecycle";

const VALID_PAIRS: [DeliberationState, DeliberationState][] = [
  ["open", "extended"],
  ["open", "closed"],
  ["extended", "closed"],
  ["closed", "summarized"],
];

describe("deliberation-lifecycle (C3 state machine)", () => {
  it.each(VALID_PAIRS)("%s -> %s is valid", (from, to) => {
    expect(isValidDeliberationTransition(from, to)).toBe(true);
    expect(() => assertValidDeliberationTransition(from, to)).not.toThrow();
  });

  // Exhaustive over all 16 (from, to) pairs — anything not in VALID_PAIRS
  // must be rejected, including no-op self-transitions.
  for (const from of DELIBERATION_STATES) {
    for (const to of DELIBERATION_STATES) {
      const isValid = VALID_PAIRS.some(([f, t]) => f === from && t === to);
      if (isValid) continue;
      it(`${from} -> ${to} is rejected`, () => {
        expect(isValidDeliberationTransition(from, to)).toBe(false);
        expect(() => assertValidDeliberationTransition(from, to)).toThrow(
          InvalidDeliberationTransitionError,
        );
      });
    }
  }

  // AC's own named example.
  it("rejects Closed -> Open explicitly", () => {
    expect(isValidDeliberationTransition("closed", "open")).toBe(false);
  });

  it("rejects any transition out of Summarized (terminal state)", () => {
    for (const to of DELIBERATION_STATES) {
      expect(isValidDeliberationTransition("summarized", to)).toBe(false);
    }
  });

  it("error carries the attempted from/to for callers to log", () => {
    try {
      assertValidDeliberationTransition("summarized", "open");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDeliberationTransitionError);
      const transitionError = error as InvalidDeliberationTransitionError;
      expect(transitionError.from).toBe("summarized");
      expect(transitionError.to).toBe("open");
    }
  });
});
