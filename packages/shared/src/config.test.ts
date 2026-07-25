import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("resolves the documented local-dev defaults when env is empty", () => {
    expect(loadConfig({})).toEqual({
      concernThresholdT2: 100,
      quorumPercent: 20,
      panelTermMonths: 6,
    });
  });

  it("env values override the defaults", () => {
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

  it("ignores explicitly undefined env values and falls back to defaults", () => {
    expect(loadConfig({ CONCERN_THRESHOLD_T2: undefined })).toEqual(
      expect.objectContaining({ concernThresholdT2: 100 }),
    );
  });

  it("rejects a non-numeric threshold", () => {
    expect(() => loadConfig({ CONCERN_THRESHOLD_T2: "not-a-number" })).toThrow();
  });

  it("rejects a quorum percent outside 0-100", () => {
    expect(() => loadConfig({ QUORUM_PERCENT: "150" })).toThrow();
  });

  it("rejects a non-positive panel term", () => {
    expect(() => loadConfig({ PANEL_TERM_MONTHS: "0" })).toThrow();
  });
});
