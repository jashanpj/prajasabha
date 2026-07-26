import { describe, expect, it } from "vitest";
import {
  epicVerificationSubmissionSchema,
  issueCreateSchema,
  issueDraftUpdateSchema,
  issuePhotoUploadSchema,
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
        turnstileToken: "XXXX.DUMMY.TOKEN",
      }),
    ).toBeTruthy();
  });

  it("rejects an invalid email", () => {
    expect(() =>
      registrationRequestSchema.parse({
        email: "not-an-email",
        pseudonym: "abc",
        locale: "ml",
        turnstileToken: "t",
      }),
    ).toThrow();
  });

  it("rejects a locale outside ml/en", () => {
    expect(() =>
      registrationRequestSchema.parse({
        email: "voter@example.com",
        pseudonym: "abc",
        locale: "hi",
        turnstileToken: "t",
      }),
    ).toThrow();
  });

  it("rejects a missing turnstileToken", () => {
    expect(() =>
      registrationRequestSchema.parse({
        email: "voter@example.com",
        pseudonym: "abc",
        locale: "ml",
      }),
    ).toThrow();
  });
});

describe("epicVerificationSubmissionSchema (A3)", () => {
  it("accepts a valid payload", () => {
    expect(
      epicVerificationSubmissionSchema.parse({
        memberId: VALID_UUID,
        docRef: "r2://vault/doc-1",
      }),
    ).toBeTruthy();
  });

  it("rejects a non-uuid memberId", () => {
    expect(() =>
      epicVerificationSubmissionSchema.parse({
        memberId: "not-a-uuid",
        docRef: "r2://vault/doc-1",
      }),
    ).toThrow();
  });

  it("never carries the raw EPIC number — vault join rule (CLAUDE.md invariant 1)", () => {
    expect(epicVerificationSubmissionSchema.shape).not.toHaveProperty("epicNo");
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

describe("issueDraftUpdateSchema (B1 — debounced autosave PATCH)", () => {
  it("accepts an empty object (a no-op autosave tick)", () => {
    expect(issueDraftUpdateSchema.parse({})).toEqual({});
  });

  it("accepts a single-field partial: titleMl", () => {
    expect(issueDraftUpdateSchema.parse({ titleMl: "ml title" })).toEqual({ titleMl: "ml title" });
  });

  it("accepts a single-field partial: titleEn", () => {
    expect(issueDraftUpdateSchema.parse({ titleEn: "en title" })).toEqual({ titleEn: "en title" });
  });

  it("accepts a single-field partial: body", () => {
    expect(issueDraftUpdateSchema.parse({ body: "body text" })).toEqual({ body: "body text" });
  });

  it("accepts a single-field partial: category", () => {
    expect(issueDraftUpdateSchema.parse({ category: "roads" })).toEqual({ category: "roads" });
  });

  it("accepts a single-field partial: wardId", () => {
    expect(issueDraftUpdateSchema.parse({ wardId: VALID_UUID })).toEqual({ wardId: VALID_UUID });
  });

  it("accepts a multi-field partial", () => {
    expect(issueDraftUpdateSchema.parse({ titleMl: "ml title", category: "roads" })).toEqual({
      titleMl: "ml title",
      category: "roads",
    });
  });

  it("rejects a wardId that is not a uuid", () => {
    expect(() => issueDraftUpdateSchema.parse({ wardId: "not-a-uuid" })).toThrow();
  });

  it("rejects an empty titleMl (still bound by issueCreateSchema's field rules when present)", () => {
    expect(() => issueDraftUpdateSchema.parse({ titleMl: "" })).toThrow();
  });
});

describe("issuePhotoUploadSchema (B1 — photo upload)", () => {
  it("accepts a valid payload", () => {
    expect(
      issuePhotoUploadSchema.parse({ photoBase64: "aGVsbG8=", filename: "photo.jpg" }),
    ).toEqual({ photoBase64: "aGVsbG8=", filename: "photo.jpg" });
  });

  it("rejects an empty photoBase64", () => {
    expect(() =>
      issuePhotoUploadSchema.parse({ photoBase64: "", filename: "photo.jpg" }),
    ).toThrow();
  });

  it("rejects a missing photoBase64", () => {
    expect(() => issuePhotoUploadSchema.parse({ filename: "photo.jpg" })).toThrow();
  });

  it("rejects an empty filename", () => {
    expect(() => issuePhotoUploadSchema.parse({ photoBase64: "aGVsbG8=", filename: "" })).toThrow();
  });

  it("rejects a missing filename", () => {
    expect(() => issuePhotoUploadSchema.parse({ photoBase64: "aGVsbG8=" })).toThrow();
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
