import { describe, expect, it } from "vitest";
import { type ConsensusStatement, type StatementTally, computeConsensus } from "./consensus";

const CONFIG = { agreementThresholdPercent: 70, minVoters: 30 };

function tally(overrides: Partial<StatementTally> = {}): StatementTally {
  return { statementId: "s1", body: "a statement", agree: 0, disagree: 0, pass: 0, ...overrides };
}

// noUncheckedIndexedAccess makes array destructuring/indexing return
// `T | undefined` — these tests always feed exactly one tally in, so this
// just asserts that invariant instead of silently narrowing with `!`.
function single(results: ConsensusStatement[]): ConsensusStatement {
  const [result] = results;
  if (!result) throw new Error("expected exactly one consensus result");
  return result;
}

describe("computeConsensus (C2 — issue #34)", () => {
  it("meets the threshold at exactly 70% agreement with enough voters", () => {
    const result = single(computeConsensus([tally({ agree: 21, disagree: 9 })], CONFIG)); // 21/30 = 70%
    expect(result.agreePercent).toBe(70);
    expect(result.sampleSize).toBe(30);
    expect(result.meetsThreshold).toBe(true);
  });

  it("fails the threshold just under 70% agreement", () => {
    const result = single(computeConsensus([tally({ agree: 20, disagree: 10 })], CONFIG)); // 20/30 = 66.67%
    expect(result.agreePercent).toBe(67);
    expect(result.meetsThreshold).toBe(false);
  });

  it("rounds a raw percentage that rounds up to exactly 70% and still meets the threshold", () => {
    // 209/300 = 69.666...% -> rounds to 70
    const result = single(computeConsensus([tally({ agree: 209, disagree: 91 })], CONFIG));
    expect(result.agreePercent).toBe(70);
    expect(result.meetsThreshold).toBe(true);
  });

  it("Pass votes affect neither the percentage nor the sample size", () => {
    const withoutPass = single(computeConsensus([tally({ agree: 21, disagree: 9 })], CONFIG));
    const withPass = single(
      computeConsensus([tally({ agree: 21, disagree: 9, pass: 500 })], CONFIG),
    );
    expect(withPass.agreePercent).toBe(withoutPass.agreePercent);
    expect(withPass.sampleSize).toBe(withoutPass.sampleSize);
    expect(withPass.meetsThreshold).toBe(withoutPass.meetsThreshold);
  });

  it("fails the threshold below minVoters even at 100% agreement", () => {
    const result = single(computeConsensus([tally({ agree: 10, disagree: 0 })], CONFIG)); // 100% but sample=10 < 30
    expect(result.agreePercent).toBe(100);
    expect(result.sampleSize).toBe(10);
    expect(result.meetsThreshold).toBe(false);
  });

  it("handles zero votes without dividing by zero", () => {
    const result = single(computeConsensus([tally({ agree: 0, disagree: 0, pass: 0 })], CONFIG));
    expect(result.agreePercent).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.meetsThreshold).toBe(false);
  });

  it("handles zero votes with only Pass votes without dividing by zero", () => {
    const result = single(computeConsensus([tally({ pass: 42 })], CONFIG));
    expect(result.sampleSize).toBe(0);
    expect(result.meetsThreshold).toBe(false);
  });

  it("maps multiple tallies independently, preserving statementId/body", () => {
    const results = computeConsensus(
      [
        tally({ statementId: "s1", body: "first", agree: 21, disagree: 9 }),
        tally({ statementId: "s2", body: "second", agree: 5, disagree: 25 }),
      ],
      CONFIG,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ statementId: "s1", body: "first", meetsThreshold: true });
    expect(results[1]).toMatchObject({ statementId: "s2", body: "second", meetsThreshold: false });
  });

  it("returns an empty array for an empty tally list", () => {
    expect(computeConsensus([], CONFIG)).toEqual([]);
  });
});
