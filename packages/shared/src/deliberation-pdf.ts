import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Issues #35 (C3) / #34 (C2). This is the deliberation's one canonical
// summary artifact — generated once by apps/jobs' lifecycle-sweep on the
// closed->summarized transition, stored in R2 (same "R2 is the blob store"
// pattern as issues.photoKeys), and served back unchanged by apps/web's
// consensus-export endpoint. Never regenerated on demand; the live,
// still-moving numbers belong on the Astro page instead (see #34's
// approved plan).
//
// English-only for this MVP (approved plan decision): pdf-lib's Standard-14
// fonts (WinAnsi/Latin only) can't render Malayalam script, and this repo
// has no Workers-safe Malayalam-capable font embedding set up yet. A
// follow-up chore tracks adding one (@pdf-lib/fontkit + a bundled Noto Sans
// Malayalam TTF) — this is a deliberate, documented exception to CLAUDE.md's
// i18n rule for this one artifact, not an oversight.
export interface ConsensusStatementForPdf {
  statementId: string;
  body: string;
  agreePercent: number;
  sampleSize: number;
}

export interface DeliberationPdfInput {
  issueTitleEn: string;
  openedAt: Date;
  closedAt: Date;
  totalT2Count: number;
  // The already-threshold-filtered "Broad agreement" set — may be empty
  // (a deliberation can close with zero qualifying statements, or, before
  // #34 lands, with zero statements at all). Must render gracefully either
  // way, not throw or produce a malformed document.
  consensusStatements: ConsensusStatementForPdf[];
  agreementThresholdPercent: number;
  minVoters: number;
  generatedAt: Date;
}

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD — locale-neutral, unambiguous
}

export async function generateDeliberationSummaryPdf(
  input: DeliberationPdfInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function newPageIfNeeded(nextLineHeight: number): void {
    if (y - nextLineHeight < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  }

  function drawLine(
    text: string,
    size: number,
    useBold = false,
    color = rgb(0.13, 0.15, 0.17),
  ): void {
    newPageIfNeeded(size + 6);
    page.drawText(text, { x: MARGIN, y, size, font: useBold ? boldFont : font, color });
    y -= size + 6;
  }

  // Wraps at CONTENT_WIDTH using the given font/size — pdf-lib has no
  // built-in wrapping, so this is a plain greedy word-wrap.
  function drawWrapped(text: string, size: number, useBold = false): void {
    const activeFont = useBold ? boldFont : font;
    const words = text.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (activeFont.widthOfTextAtSize(candidate, size) > CONTENT_WIDTH && line) {
        drawLine(line, size, useBold);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) drawLine(line, size, useBold);
  }

  drawLine("Deliberation Summary", 20, true);
  drawLine(input.issueTitleEn, 14, true);
  y -= 6;

  drawLine(`Deliberation opened: ${formatDate(input.openedAt)}`, 11);
  drawLine(`Deliberation closed: ${formatDate(input.closedAt)}`, 11);
  drawLine(`Report generated: ${formatDate(input.generatedAt)}`, 11);
  y -= 10;

  drawLine("Broad Agreement", 15, true);
  drawWrapped(
    `Statements below reached at least ${input.agreementThresholdPercent}% agreement across at ` +
      `least ${input.minVoters} verified constituents (of ${input.totalT2Count} total).`,
    10,
  );
  y -= 8;

  if (input.consensusStatements.length === 0) {
    drawLine("No statements reached the broad-agreement threshold.", 11);
  } else {
    for (const statement of input.consensusStatements) {
      newPageIfNeeded(40);
      drawWrapped(`"${statement.body}"`, 12);
      drawLine(
        `${statement.agreePercent}% agree (sample: ${statement.sampleSize})`,
        10,
        false,
        rgb(0.09, 0.35, 0.2),
      );
      y -= 6;
    }
  }

  return doc.save();
}
