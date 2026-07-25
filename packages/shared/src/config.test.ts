import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const VALID_ENV = {
  CONCERN_THRESHOLD_T2: "100",
  QUORUM_PERCENT: "20",
  PANEL_TERM_MONTHS: "6",
};

describe("loadConfig", () => {
  it("resolves config from a fully-populated env", () => {
    expect(loadConfig(VALID_ENV)).toEqual({
      concernThresholdT2: 100,
      quorumPercent: 20,
      panelTermMonths: 6,
    });
  });

  it("env values are used verbatim, not silently defaulted", () => {
    expect(
      loadConfig({
        CONCERN_THRESHOLD_T2: "150",
        QUORUM_PERCENT: "25",
        PANEL_TERM_MONTHS: "12",
      }),
    ).toEqual({
      concernThresholdT2: 150,
      quorumPercent: 25,
      panelTermMonths: 12,
    });
  });

  it("throws when env is empty (no silent fallback to real thresholds — CLAUDE.md invariant 6)", () => {
    expect(() => loadConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws when a single required var is missing", () => {
    const { CONCERN_THRESHOLD_T2: _omit, ...rest } = VALID_ENV;
    expect(() => loadConfig(rest)).toThrow(/CONCERN_THRESHOLD_T2/);
  });

  it("rejects a non-numeric threshold", () => {
    expect(() => loadConfig({ ...VALID_ENV, CONCERN_THRESHOLD_T2: "not-a-number" })).toThrow();
  });

  it("rejects a quorum percent outside 0-100", () => {
    expect(() => loadConfig({ ...VALID_ENV, QUORUM_PERCENT: "150" })).toThrow();
  });

  it("rejects a non-positive panel term", () => {
    expect(() => loadConfig({ ...VALID_ENV, PANEL_TERM_MONTHS: "0" })).toThrow();
  });
});
