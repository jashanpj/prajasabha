// Canonical product-law status strings (packages/shared/status.ts). Copy
// exactly from CLAUDE.md's "Product law" section — never re-typed inline
// anywhere else in the codebase (the i18n-auditor subagent checks for
// this). Includes the literal glyphs (U+2192 →, U+2713 ✓, U+2013 – en
// dash, U+2014 — em dash) as part of the strings, not decoration added at
// render time.
export const STATUS_DELIVERED = "Delivered";
export const STATUS_ACKNOWLEDGED = "→ Acknowledged";
export const STATUS_ACTED_UPON = "✓ Acted upon";

/**
 * "– No response — N days" is a template, not a literal string — N is a
 * live day count. Still routes through this module so the fixed parts of
 * the string (glyphs, wording) can never drift from product law.
 */
export function statusNoResponse(days: number): string {
  return `– No response — ${days} days`;
}
