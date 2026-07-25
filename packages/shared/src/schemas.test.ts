import { describe, expect, it } from "vitest";
import {
  epicVerificationSubmissionSchema,
  issueCreateSchema,
  issueSupportActionSchema,
  registrationRequestSchema,
} from "./schemas";

// Standard RFC 4122 example UUID (used widely in API docs) — deliberately
// not a run of grouped digits, so it doesn't look like an Aadhaar/EPIC-style
// ID to the repo's secret-scan hook or to a human skimming this file.
const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("registrationRequestSchema (A1, email magic-link)", () => {
  it("accepts a valid payload", () => {
    expect(
      registrationRequestSchema.parse({
        email: "voter@example.com",
        pseudonym: "Constituent K-417",
        locale: "ml",
      }),
    ).toBeTruthy();
  });

  it("rejects an invalid email", () => {
    expect(() =>
      registrationRequestSchema.parse({ email: "not-an-email", pseudonym: "abc", locale: "ml" }),
    ).toThrow();
  });

  it("rejects a locale outside ml/en", () => {
    expect(() =>
      registrationRequestSchema.parse({
        email: "voter@example.com",
        pseudonym: "abc",
        locale: "hi",
      }),
    ).toThrow();
  });
});

describe("epicVerificationSubmissionSchema (A3)", () => {
  it("accepts a valid payload", () => {
    expect(
      epicVerificationSubmissionSchema.parse({
        memberId: VALID_UUID,
        epicNo: "ABC1234567",
        docRef: "r2://vault/doc-1",
      }),
    ).toBeTruthy();
  });

  it("rejects a non-uuid memberId", () => {
    expect(() =>
      epicVerificationSubmissionSchema.parse({
        memberId: "not-a-uuid",
        epicNo: "ABC1234567",
        docRef: "r2://vault/doc-1",
      }),
    ).toThrow();
  });
});

describe("issueCreateSchema (B1)", () => {
  it("accepts a valid payload", () => {
    expect(
      issueCreateSchema.parse({
        titleMl: "ml title",
        titleEn: "en title",
        body: "body text",
        category: "roads",
        wardId: VALID_UUID,
      }),
    ).toBeTruthy();
  });

  it("rejects an empty title", () => {
    expect(() =>
      issueCreateSchema.parse({
        titleMl: "",
        titleEn: "en title",
        body: "body text",
        category: "roads",
        wardId: VALID_UUID,
      }),
    ).toThrow();
  });
});

describe("issueSupportActionSchema (B3/B4)", () => {
  it("accepts a valid payload", () => {
    expect(
      issueSupportActionSchema.parse({ issueId: VALID_UUID, memberId: VALID_UUID }),
    ).toBeTruthy();
  });

  it("rejects a non-uuid issueId", () => {
    expect(() =>
      issueSupportActionSchema.parse({ issueId: "not-a-uuid", memberId: VALID_UUID }),
    ).toThrow();
  });
});
