// Issue #35 — C3 Deliberation Lifecycle. Pure state machine, no DB
// coupling — Postgres can't declaratively express "valid transition from
// this row's current value" (a CHECK only sees the new row), so the
// invariant lives here instead and is applied as defense-in-depth by every
// caller that performs the actual compare-and-swap UPDATE (see
// apps/jobs/src/lifecycle-sweep.ts), same spirit as issues.promotedAt's CAS
// guard in support.ts.
export const DELIBERATION_STATES = ["open", "extended", "closed", "summarized"] as const;

export type DeliberationState = (typeof DELIBERATION_STATES)[number];

// Extended->Open, Closed->Open/Extended, Summarized->anything: all invalid.
// Open->Closed (skipping Extended) is valid — panel extension (Module D,
// unbuilt) is optional, not a required waypoint.
const VALID_TRANSITIONS: Record<DeliberationState, readonly DeliberationState[]> = {
  open: ["extended", "closed"],
  extended: ["closed"],
  closed: ["summarized"],
  summarized: [],
};

export function isValidDeliberationTransition(
  from: DeliberationState,
  to: DeliberationState,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class InvalidDeliberationTransitionError extends Error {
  constructor(
    public readonly from: DeliberationState,
    public readonly to: DeliberationState,
  ) {
    super(`Invalid deliberation state transition: ${from} -> ${to}`);
    this.name = "InvalidDeliberationTransitionError";
  }
}

export function assertValidDeliberationTransition(
  from: DeliberationState,
  to: DeliberationState,
): void {
  if (!isValidDeliberationTransition(from, to)) {
    throw new InvalidDeliberationTransitionError(from, to);
  }
}
