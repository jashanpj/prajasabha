import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadEpicLinkRateLimitConfig,
  loadEpicSubmitRateLimitConfig,
  loadEpicVerificationConfig,
  loadFlagRoutingRateLimitConfig,
  loadIssueCategoriesConfig,
  loadIssueCreateRateLimitConfig,
  loadIssueDraftRateLimitConfig,
  loadIssueMergeAdminConfig,
  loadIssuePhotoRateLimitConfig,
  loadIssuePublishRateLimitConfig,
  loadIssueSupportRateLimitConfig,
  loadMagicLinkConfig,
  loadPilotWardsConfig,
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

// Issue #24 — B1 "Raise an Issue" form. Both are the "config, not schema"
// treatment the approved plan confirms for issues.category/issues.wardId —
// no wards/categories lookup table exists (see packages/db/src/schema.ts's
// own comment on `category`), same pattern as loadEpicVerificationConfig
// above.

const VALID_ISSUE_CATEGORIES_ENV = {
  ISSUE_CATEGORIES: "roads,water,electricity",
};

const VALID_UUID_1 = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VALID_UUID_2 = "5b1b6e1e-1c1a-4e1a-9c1a-2c963f66afa6";

const VALID_PILOT_WARDS_ENV = {
  PILOT_WARD_IDS: `${VALID_UUID_1},${VALID_UUID_2}`,
  PILOT_WARD_NAMES_ML: "വാർഡ് 1,വാർഡ് 2",
  PILOT_WARD_NAMES_EN: "Ward 1,Ward 2",
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

describe("loadIssueCategoriesConfig (B1 — issue #24)", () => {
  it("resolves a comma-separated category list from env into an array", () => {
    expect(loadIssueCategoriesConfig(VALID_ISSUE_CATEGORIES_ENV)).toEqual({
      issueCategories: ["roads", "water", "electricity"],
    });
  });

  it("trims whitespace around each category code", () => {
    expect(loadIssueCategoriesConfig({ ISSUE_CATEGORIES: " roads , water " })).toEqual({
      issueCategories: ["roads", "water"],
    });
  });

  it("resolves a single category without a trailing comma", () => {
    expect(loadIssueCategoriesConfig({ ISSUE_CATEGORIES: "roads" })).toEqual({
      issueCategories: ["roads"],
    });
  });

  it("does not require core, magic-link, or rate-limit vars", () => {
    expect(() => loadIssueCategoriesConfig(VALID_ISSUE_CATEGORIES_ENV)).not.toThrow();
  });

  it("throws when env is empty (no silent fallback — CLAUDE.md invariant 6)", () => {
    expect(() => loadIssueCategoriesConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws naming the missing var", () => {
    expect(() => loadIssueCategoriesConfig({})).toThrow(/ISSUE_CATEGORIES/);
  });
});

describe("loadPilotWardsConfig (B1 — issue #24)", () => {
  it("zips the three index-aligned comma lists into {id, nameMl, nameEn}[]", () => {
    expect(loadPilotWardsConfig(VALID_PILOT_WARDS_ENV)).toEqual({
      pilotWards: [
        { id: VALID_UUID_1, nameMl: "വാർഡ് 1", nameEn: "Ward 1" },
        { id: VALID_UUID_2, nameMl: "വാർഡ് 2", nameEn: "Ward 2" },
      ],
    });
  });

  it("resolves a single ward without a trailing comma", () => {
    expect(
      loadPilotWardsConfig({
        PILOT_WARD_IDS: VALID_UUID_1,
        PILOT_WARD_NAMES_ML: "വാർഡ് 1",
        PILOT_WARD_NAMES_EN: "Ward 1",
      }),
    ).toEqual({ pilotWards: [{ id: VALID_UUID_1, nameMl: "വാർഡ് 1", nameEn: "Ward 1" }] });
  });

  it("does not require core, magic-link, or rate-limit vars", () => {
    expect(() => loadPilotWardsConfig(VALID_PILOT_WARDS_ENV)).not.toThrow();
  });

  it("throws when env is empty", () => {
    expect(() => loadPilotWardsConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws when only PILOT_WARD_IDS is missing", () => {
    const { PILOT_WARD_IDS: _omit, ...rest } = VALID_PILOT_WARDS_ENV;
    expect(() => loadPilotWardsConfig(rest)).toThrow(/PILOT_WARD_IDS/);
  });

  it("throws when only PILOT_WARD_NAMES_ML is missing", () => {
    const { PILOT_WARD_NAMES_ML: _omit, ...rest } = VALID_PILOT_WARDS_ENV;
    expect(() => loadPilotWardsConfig(rest)).toThrow(/PILOT_WARD_NAMES_ML/);
  });

  it("throws when only PILOT_WARD_NAMES_EN is missing", () => {
    const { PILOT_WARD_NAMES_EN: _omit, ...rest } = VALID_PILOT_WARDS_ENV;
    expect(() => loadPilotWardsConfig(rest)).toThrow(/PILOT_WARD_NAMES_EN/);
  });
});

describe("loadIssueCreateRateLimitConfig (B1 — issue #24)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadIssueCreateRateLimitConfig({ ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "20" }),
    ).toEqual({ issueCreateRateLimitPerMemberPerHour: 20 });
  });

  it("throws when env is empty", () => {
    expect(() => loadIssueCreateRateLimitConfig({})).toThrow(
      /ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadIssueCreateRateLimitConfig({ ISSUE_CREATE_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadIssueDraftRateLimitConfig (B1 — issue #24)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadIssueDraftRateLimitConfig({ ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "120" }),
    ).toEqual({ issueDraftRateLimitPerMemberPerHour: 120 });
  });

  it("throws when env is empty", () => {
    expect(() => loadIssueDraftRateLimitConfig({})).toThrow(
      /ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadIssueDraftRateLimitConfig({ ISSUE_DRAFT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadIssuePhotoRateLimitConfig (B1 — issue #24)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadIssuePhotoRateLimitConfig({ ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR: "60" }),
    ).toEqual({ issuePhotoRateLimitPerMemberPerHour: 60 });
  });

  it("throws when env is empty", () => {
    expect(() => loadIssuePhotoRateLimitConfig({})).toThrow(
      /ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadIssuePhotoRateLimitConfig({ ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadIssuePublishRateLimitConfig (B1 — issue #24)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadIssuePublishRateLimitConfig({ ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR: "20" }),
    ).toEqual({ issuePublishRateLimitPerMemberPerHour: 20 });
  });

  it("throws when env is empty", () => {
    expect(() => loadIssuePublishRateLimitConfig({})).toThrow(
      /ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadIssuePublishRateLimitConfig({ ISSUE_PUBLISH_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

describe("loadFlagRoutingRateLimitConfig (B2 — issue #25)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadFlagRoutingRateLimitConfig({ FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR: "10" }),
    ).toEqual({ flagRoutingRateLimitPerMemberPerHour: 10 });
  });

  it("throws when env is empty", () => {
    expect(() => loadFlagRoutingRateLimitConfig({})).toThrow(
      /FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadFlagRoutingRateLimitConfig({ FLAG_ROUTING_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

// Issue #26 — B3 (Support & Dedup). Same per-member (not per-IP) treatment
// as #24/#25's loaders above — support.ts is session-authed, so no
// enumeration risk — added as its own loader, same "distinct consumer file"
// reasoning as loadFlagRoutingRateLimitConfig.

describe("loadIssueSupportRateLimitConfig (B3 — issue #26)", () => {
  it("resolves the per-member rate limit from env", () => {
    expect(
      loadIssueSupportRateLimitConfig({ ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "20" }),
    ).toEqual({ issueSupportRateLimitPerMemberPerHour: 20 });
  });

  it("throws when env is empty", () => {
    expect(() => loadIssueSupportRateLimitConfig({})).toThrow(
      /ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR/,
    );
  });

  it("rejects a non-positive rate limit", () => {
    expect(() =>
      loadIssueSupportRateLimitConfig({ ISSUE_SUPPORT_RATE_LIMIT_PER_MEMBER_PER_HOUR: "0" }),
    ).toThrow();
  });
});

// Issue #26 — B3's admin-only merge endpoint. There is no admin-role model
// anywhere in this codebase yet (per the approved plan), so this mirrors
// apps/vault-svc's loadReviewQueueConfig comma-separated IP allowlist
// pattern almost verbatim, plus a required non-empty bearer token (the
// second, independent factor requireAdminAccess checks — a leaked
// merge-admin token must not by itself grant access from a non-allow-listed
// IP, and vice versa).

describe("loadIssueMergeAdminConfig (B3 — issue #26)", () => {
  it("resolves the admin token and a comma-separated IP allowlist from env", () => {
    expect(
      loadIssueMergeAdminConfig({
        ISSUE_MERGE_ADMIN_TOKEN: "merge-admin-token",
        ISSUE_MERGE_ADMIN_IP_ALLOWLIST: "203.0.113.10,203.0.113.11",
      }),
    ).toEqual({
      adminToken: "merge-admin-token",
      ipAllowlist: ["203.0.113.10", "203.0.113.11"],
    });
  });

  it("trims whitespace around each allowlisted IP", () => {
    expect(
      loadIssueMergeAdminConfig({
        ISSUE_MERGE_ADMIN_TOKEN: "merge-admin-token",
        ISSUE_MERGE_ADMIN_IP_ALLOWLIST: " 203.0.113.10 , 203.0.113.11 ",
      }),
    ).toEqual({
      adminToken: "merge-admin-token",
      ipAllowlist: ["203.0.113.10", "203.0.113.11"],
    });
  });

  it("resolves a single-IP allowlist without a trailing comma", () => {
    expect(
      loadIssueMergeAdminConfig({
        ISSUE_MERGE_ADMIN_TOKEN: "merge-admin-token",
        ISSUE_MERGE_ADMIN_IP_ALLOWLIST: "203.0.113.10",
      }),
    ).toEqual({ adminToken: "merge-admin-token", ipAllowlist: ["203.0.113.10"] });
  });

  it("throws when env is empty (no silent fallback — CLAUDE.md invariant 6)", () => {
    expect(() => loadIssueMergeAdminConfig({})).toThrow(/Missing required config env var/);
  });

  it("throws naming the missing admin token var", () => {
    expect(() =>
      loadIssueMergeAdminConfig({ ISSUE_MERGE_ADMIN_IP_ALLOWLIST: "203.0.113.10" }),
    ).toThrow(/ISSUE_MERGE_ADMIN_TOKEN/);
  });

  it("throws naming the missing IP allowlist var", () => {
    expect(() =>
      loadIssueMergeAdminConfig({ ISSUE_MERGE_ADMIN_TOKEN: "merge-admin-token" }),
    ).toThrow(/ISSUE_MERGE_ADMIN_IP_ALLOWLIST/);
  });

  it("rejects an empty admin token", () => {
    expect(() =>
      loadIssueMergeAdminConfig({
        ISSUE_MERGE_ADMIN_TOKEN: "",
        ISSUE_MERGE_ADMIN_IP_ALLOWLIST: "203.0.113.10",
      }),
    ).toThrow();
  });
});
