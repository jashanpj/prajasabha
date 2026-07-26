import type { ConsensusConfig } from "./config";

// Issue #34 — C2 Consensus Surface. Pure math, no DB coupling — the
// "Broad agreement" section surfaces statements clearing a configurable
// agreement-percentage threshold across a configurable minimum number of
// voters (the story's own text; both figures are env-driven via
// loadConsensusConfig, per CLAUDE.md invariant 6 — no threshold value is
// stated here). Denominator is agree/(agree+disagree) — Pass votes are
// excluded entirely from both the percentage and the sample size
// (approved plan decision), so a statement with lots of Pass votes isn't
// penalized or inflated by them either way.
// Reuses config.ts's ConsensusConfig shape ({agreementThresholdPercent,
// minVoters}) rather than declaring a second, identically-shaped type —
// this is the same threshold loadConsensusConfig resolves from env,
// consumed here for the actual computation.
export interface StatementTally {
  statementId: string;
  body: string;
  agree: number;
  disagree: number;
  pass: number;
}

export interface ConsensusStatement {
  statementId: string;
  body: string;
  agreePercent: number;
  sampleSize: number;
  meetsThreshold: boolean;
}

export function computeConsensus(
  tallies: StatementTally[],
  config: ConsensusConfig,
): ConsensusStatement[] {
  return tallies.map((tally) => {
    const sampleSize = tally.agree + tally.disagree;
    const rawPercent = sampleSize === 0 ? 0 : (tally.agree / sampleSize) * 100;
    const agreePercent = Math.round(rawPercent);
    return {
      statementId: tally.statementId,
      body: tally.body,
      agreePercent,
      sampleSize,
      // Compares the ROUNDED display percentage, not the raw float — a
      // statement visually showing "N%" must never be excluded from Broad
      // agreement, which is also what makes "exactly at the threshold vs.
      // just under it" an unambiguous boundary to test.
      meetsThreshold:
        agreePercent >= config.agreementThresholdPercent && sampleSize >= config.minVoters,
    };
  });
}
