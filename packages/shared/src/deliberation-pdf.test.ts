import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { type DeliberationPdfInput, generateDeliberationSummaryPdf } from "./deliberation-pdf";

const BASE_INPUT: DeliberationPdfInput = {
  issueTitleEn: "Waterlogging at Edappally Junction underpass",
  openedAt: new Date("2026-06-01T00:00:00Z"),
  closedAt: new Date("2026-06-15T00:00:00Z"),
  totalT2Count: 24318,
  consensusStatements: [],
  agreementThresholdPercent: 70,
  minVoters: 30,
  generatedAt: new Date("2026-06-15T01:00:00Z"),
};

async function loadPageCount(bytes: Uint8Array): Promise<number> {
  const loaded = await PDFDocument.load(bytes);
  return loaded.getPageCount();
}

describe("generateDeliberationSummaryPdf (C3/C2 — issues #35/#34)", () => {
  it("returns bytes starting with the %PDF- magic header", async () => {
    const bytes = await generateDeliberationSummaryPdf(BASE_INPUT);
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("round-trips through PDFDocument.load without throwing, with zero consensus statements", async () => {
    const bytes = await generateDeliberationSummaryPdf(BASE_INPUT);
    await expect(loadPageCount(bytes)).resolves.toBeGreaterThanOrEqual(1);
  });

  it("round-trips with a populated consensus-statement list", async () => {
    const bytes = await generateDeliberationSummaryPdf({
      ...BASE_INPUT,
      consensusStatements: [
        {
          statementId: "s1",
          body: "Pump capacity must be upgraded before the next monsoon.",
          agreePercent: 91,
          sampleSize: 2417,
        },
        {
          statementId: "s2",
          body: "The Corporation should publish pump maintenance logs monthly.",
          agreePercent: 84,
          sampleSize: 2201,
        },
      ],
    });
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
    await expect(loadPageCount(bytes)).resolves.toBeGreaterThanOrEqual(1);
  });

  it("paginates gracefully with a very long consensus-statement list", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      statementId: `s${i}`,
      body: `Statement number ${i} with some representative body text describing a civic concern in enough detail to wrap across multiple lines.`,
      agreePercent: 70 + (i % 30),
      sampleSize: 30 + i,
    }));
    const bytes = await generateDeliberationSummaryPdf({
      ...BASE_INPUT,
      consensusStatements: many,
    });
    const pageCount = await loadPageCount(bytes);
    expect(pageCount).toBeGreaterThan(1);
  });
});
