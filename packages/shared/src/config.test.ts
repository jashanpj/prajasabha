import { describe, expect, it } from "vitest";
import { loadConfig, loadMagicLinkConfig, loadRateLimitConfig } from "./config";

const VALID_CORE_ENV = {
  CONCERN_THRESHOLD_T2: "100",
  QUORUM_PERCENT: "20",
  PANEL_TERM_MONTHS: "6",
};

const VALID_MAGIC_LINK_ENV = { MAGIC_LINK_TTL_MINUTES: "15" };

const VALID_RATE_LIMIT_ENV = {
  REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: "5",
  REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: "20",
  VERIFY_RATE_LIMIT_PER_IP_PER_HOUR: "30",
};

describe("loadConfig", () => {
  it("resolves config from a fully-populated env", () => {
    expect(loadConfig(VALID_CORE_ENV)).toEqual({
      concernThresholdT2: 100,
      quorumPercent: 20,
      panelTermMonths: 6,
    });
  });

  it("does not require magic-link/rate-limit vars", () => {
    expect(() => loadConfig(VALID_CORE_ENV)).not.toThrow();
  });

  it("env values are used verbatim, not silently defaulted", () => {
    expect(
      loadConfig({ CONCERN_THRESHOLD_T2: "150", QUORUM_PERCENT: "25", PANEL_TERM_MONTHS: "12" }),
    ).toEqual({ concernThresholdT2: 150, quorumPercent: 25, panelTermMonths: 12 });
  });

  it("throws when env is empty (no silent fallback to real thresholds — CLAUDE.md invariant 6)", () => {
    expect(() => loadConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws when a single required var is missing", () => {
    const { CONCERN_THRESHOLD_T2: _omit, ...rest } = VALID_CORE_ENV;
    expect(() => loadConfig(rest)).toThrow(/CONCERN_THRESHOLD_T2/);
  });

  it("rejects a non-numeric threshold", () => {
    expect(() => loadConfig({ ...VALID_CORE_ENV, CONCERN_THRESHOLD_T2: "not-a-number" })).toThrow();
  });

  it("rejects a quorum percent outside 0-100", () => {
    expect(() => loadConfig({ ...VALID_CORE_ENV, QUORUM_PERCENT: "150" })).toThrow();
  });

  it("rejects a non-positive panel term", () => {
    expect(() => loadConfig({ ...VALID_CORE_ENV, PANEL_TERM_MONTHS: "0" })).toThrow();
  });
});

describe("loadMagicLinkConfig", () => {
  it("resolves the TTL from env", () => {
    expect(loadMagicLinkConfig(VALID_MAGIC_LINK_ENV)).toEqual({ magicLinkTtlMinutes: 15 });
  });

  it("does not require core or rate-limit vars", () => {
    expect(() => loadMagicLinkConfig(VALID_MAGIC_LINK_ENV)).not.toThrow();
  });

  it("throws when env is empty", () => {
    expect(() => loadMagicLinkConfig({})).toThrow(/MAGIC_LINK_TTL_MINUTES/);
  });

  it("rejects a non-positive TTL", () => {
    expect(() => loadMagicLinkConfig({ MAGIC_LINK_TTL_MINUTES: "0" })).toThrow();
  });
});

describe("loadRateLimitConfig", () => {
  it("resolves rate limits from env", () => {
    expect(loadRateLimitConfig(VALID_RATE_LIMIT_ENV)).toEqual({
      registerRateLimitPerEmailPerHour: 5,
      registerRateLimitPerIpPerHour: 20,
      verifyRateLimitPerIpPerHour: 30,
    });
  });

  it("does not require core or magic-link vars", () => {
    expect(() => loadRateLimitConfig(VALID_RATE_LIMIT_ENV)).not.toThrow();
  });

  it("throws when env is empty", () => {
    expect(() => loadRateLimitConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws when a single var is missing", () => {
    const { REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: _omit, ...rest } = VALID_RATE_LIMIT_ENV;
    expect(() => loadRateLimitConfig(rest)).toThrow(/REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR/);
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadRateLimitConfig({ ...VALID_RATE_LIMIT_ENV, REGISTER_RATE_LIMIT_PER_EMAIL_PER_HOUR: "0" }),
    ).toThrow();
  });
});
