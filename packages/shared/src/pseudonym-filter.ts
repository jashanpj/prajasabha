// Pseudonym validation for T0 registration (issue #20 AC: "profanity/
// party-name filter on pseudonyms"). This is a minimal viable filter — a
// case-insensitive substring denylist, not comprehensive moderation.
// False positives/negatives are expected; extend the lists below as
// real-world reports come in via the moderation_actions pipeline. It is
// not a substitute for human review.
//
// PLACEHOLDER PROFANITY LIST: intentionally not populated with a real
// English/Malayalam profanity or slur wordlist by this (AI-authored)
// change — getting that list right (complete, correctly scoped, not
// itself offensive or embarrassing) needs native-speaker judgment, not a
// guess baked into a public repo. The single marker entry below exists
// only to prove the mechanism end-to-end; replace this list with a real,
// reviewed one before relying on this filter in production.
const PROFANITY_DENYLIST = ["xxxplaceholderprofanityxxx"];

// Kerala-relevant party names/abbreviations (EN) — real and safe to
// commit, these are just political party names, not offensive content.
// Malayalam-script equivalents are intentionally omitted here for the
// same reason as above: transliteration needs a native speaker to get
// right, not a guess.
const PARTY_NAME_DENYLIST = ["cpm", "cpi", "inc", "bjp", "iuml", "ldf", "udf", "nda"];

const MIN_LENGTH = 3;
const MAX_LENGTH = 32;

export type PseudonymRejectionReason = "too-short" | "too-long" | "profanity" | "party-name";

export interface PseudonymCheckResult {
  allowed: boolean;
  reason?: PseudonymRejectionReason;
}

function containsAny(haystack: string, denylist: readonly string[]): boolean {
  return denylist.some((word) => haystack.includes(word));
}

export function checkPseudonym(pseudonym: string): PseudonymCheckResult {
  if (pseudonym.length < MIN_LENGTH) return { allowed: false, reason: "too-short" };
  if (pseudonym.length > MAX_LENGTH) return { allowed: false, reason: "too-long" };

  const normalized = pseudonym.toLowerCase();
  if (containsAny(normalized, PROFANITY_DENYLIST)) return { allowed: false, reason: "profanity" };
  if (containsAny(normalized, PARTY_NAME_DENYLIST)) return { allowed: false, reason: "party-name" };

  return { allowed: true };
}
