import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadEpicLinkRateLimitConfig,
  loadEpicSubmitRateLimitConfig,
  loadEpicVerificationConfig,
  loadMagicLinkConfig,
  loadRateLimitConfig,
  loadReviewQueueConfig,
} from "./config";

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

// Issue #22 — A3 T2 verification (EPIC / Voter ID → constituency mapping).

const VALID_REVIEW_QUEUE_ENV = {
  REVIEW_QUEUE_IP_ALLOWLIST: "203.0.113.10,203.0.113.11",
};

const VALID_EPIC_VERIFICATION_ENV = {
  PILOT_CONSTITUENCY_NAME_ML: "പൈലറ്റ് മണ്ഡലം",
  PILOT_CONSTITUENCY_NAME_EN: "Pilot Constituency",
  COVERED_ASSEMBLY_SEGMENTS: "Segment One,Segment Two",
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

describe("loadReviewQueueConfig", () => {
  it("resolves a comma-separated IP allowlist from env into an array", () => {
    expect(loadReviewQueueConfig(VALID_REVIEW_QUEUE_ENV)).toEqual({
      ipAllowlist: ["203.0.113.10", "203.0.113.11"],
    });
  });

  it("trims whitespace around each allowlisted IP", () => {
    expect(
      loadReviewQueueConfig({ REVIEW_QUEUE_IP_ALLOWLIST: " 203.0.113.10 , 203.0.113.11 " }),
    ).toEqual({ ipAllowlist: ["203.0.113.10", "203.0.113.11"] });
  });

  it("resolves a single-IP allowlist without a trailing comma", () => {
    expect(loadReviewQueueConfig({ REVIEW_QUEUE_IP_ALLOWLIST: "203.0.113.10" })).toEqual({
      ipAllowlist: ["203.0.113.10"],
    });
  });

  it("does not require core, magic-link, or rate-limit vars", () => {
    expect(() => loadReviewQueueConfig(VALID_REVIEW_QUEUE_ENV)).not.toThrow();
  });

  it("throws when env is empty (no silent fallback — CLAUDE.md invariant 6)", () => {
    expect(() => loadReviewQueueConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws naming the missing var", () => {
    expect(() => loadReviewQueueConfig({})).toThrow(/REVIEW_QUEUE_IP_ALLOWLIST/);
  });
});

describe("loadEpicSubmitRateLimitConfig", () => {
  it("resolves the per-IP rate limit from env", () => {
    expect(loadEpicSubmitRateLimitConfig({ EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "10" })).toEqual(
      { epicSubmitRateLimitPerIpPerHour: 10 },
    );
  });

  it("does not require the link rate-limit var (separate loader, separate consumer)", () => {
    expect(() =>
      loadEpicSubmitRateLimitConfig({ EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "10" }),
    ).not.toThrow();
  });

  it("throws when env is empty (no silent fallback — CLAUDE.md invariant 6)", () => {
    expect(() => loadEpicSubmitRateLimitConfig({})).toThrow(
      /EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadEpicSubmitRateLimitConfig({ EPIC_SUBMIT_RATE_LIMIT_PER_IP_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadEpicLinkRateLimitConfig", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(loadEpicLinkRateLimitConfig({ EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: "5" })).toEqual({
      epicLinkRateLimitPerMemberPerHour: 5,
    });
  });

  it("does not require the submit rate-limit var (separate loader, separate consumer)", () => {
    expect(() =>
      loadEpicLinkRateLimitConfig({ EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: "5" }),
    ).not.toThrow();
  });

  it("throws when env is empty", () => {
    expect(() => loadEpicLinkRateLimitConfig({})).toThrow(
      /EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadEpicLinkRateLimitConfig({ EPIC_LINK_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadEpicVerificationConfig", () => {
  it("resolves the pilot constituency names and covered assembly segments from env", () => {
    expect(loadEpicVerificationConfig(VALID_EPIC_VERIFICATION_ENV)).toEqual({
      pilotConstituencyNameMl: "പൈലറ്റ് മണ്ഡലം",
      pilotConstituencyNameEn: "Pilot Constituency",
      coveredAssemblySegments: ["Segment One", "Segment Two"],
    });
  });

  it("does not require core, magic-link, or rate-limit vars", () => {
    expect(() => loadEpicVerificationConfig(VALID_EPIC_VERIFICATION_ENV)).not.toThrow();
  });

  it("throws when env is empty", () => {
    expect(() => loadEpicVerificationConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws when only PILOT_CONSTITUENCY_NAME_ML is missing", () => {
    const { PILOT_CONSTITUENCY_NAME_ML: _omit, ...rest } = VALID_EPIC_VERIFICATION_ENV;
    expect(() => loadEpicVerificationConfig(rest)).toThrow(/PILOT_CONSTITUENCY_NAME_ML/);
  });

  it("throws when only PILOT_CONSTITUENCY_NAME_EN is missing", () => {
    const { PILOT_CONSTITUENCY_NAME_EN: _omit, ...rest } = VALID_EPIC_VERIFICATION_ENV;
    expect(() => loadEpicVerificationConfig(rest)).toThrow(/PILOT_CONSTITUENCY_NAME_EN/);
  });

  it("throws when only COVERED_ASSEMBLY_SEGMENTS is missing", () => {
    const { COVERED_ASSEMBLY_SEGMENTS: _omit, ...rest } = VALID_EPIC_VERIFICATION_ENV;
    expect(() => loadEpicVerificationConfig(rest)).toThrow(/COVERED_ASSEMBLY_SEGMENTS/);
  });

  it("resolves a single covered assembly segment without a trailing comma", () => {
    expect(
      loadEpicVerificationConfig({
        ...VALID_EPIC_VERIFICATION_ENV,
        COVERED_ASSEMBLY_SEGMENTS: "Only Segment",
      }),
    ).toEqual({
      pilotConstituencyNameMl: "പൈലറ്റ് മണ്ഡലം",
      pilotConstituencyNameEn: "Pilot Constituency",
      coveredAssemblySegments: ["Only Segment"],
    });
  });
});
