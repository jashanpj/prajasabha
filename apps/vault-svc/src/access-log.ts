import { loadVaultAccessAlertConfig } from "shared";
import { type createVaultDbClient, schema } from "vault-db";

// Vault access logging (issue #23 / A4). HLD §4.1: "All vault reads append to
// an access log alerting to founders." Before this, nothing in the vault was
// logged at all — no audit table, no middleware, not even a console call.
//
// Called explicitly at each read site rather than as blanket Hono middleware,
// deliberately: `rowCount` and `subjectRef` are only knowable inside the
// handler, and middleware would also log requests that read no identity data
// at all — diluting the one signal this log exists to carry, namely "someone
// read identity data, and how much of it".

/**
 * Closed vocabulary of vault operations. These name a VAULT operation, never a
 * civic action — CLAUDE.md invariant 1 forbids this table from ever carrying a
 * civic-activity attribute, and a free-form string would be the easy way to
 * smuggle one in. access-log.test.ts asserts every logged value is from here.
 */
export const VAULT_ACCESS_OPERATIONS = [
  "registration.start.duplicate_check",
  "registration.consume",
  "registration.complete.lookup",
  "epic.link.lookup",
  "epic.status",
  "epic.review_queue",
] as const;

export type VaultAccessOperation = (typeof VAULT_ACCESS_OPERATIONS)[number];

/** Which authorisation gate admitted the caller — not the token, not the IP. */
export type VaultAccessCaller = "internal" | "review";

export type VaultAccessOutcome = "ok" | "not_found" | "denied";

export interface VaultAccessEntry {
  operation: VaultAccessOperation;
  caller: VaultAccessCaller;
  outcome: VaultAccessOutcome;
  /** How many identity rows the caller was actually exposed to. */
  rowCount: number;
  /**
   * The VAULT ROW touched — `epic_verifications.verification_id` or
   * `auth_credentials.id`.
   *
   * **Never a member_id.** `epic_verifications.member_id` is the only
   * vault→participation link in the system, and both `vault-db`'s schema header
   * and `docs/vault-blast-radius.md` rest on that being true; putting a
   * member_id here would quietly create a second one. A member-scoped read
   * (e.g. `/internal/epic/status`, which is keyed BY member_id) must therefore
   * log the row it found, not the key it searched with — see that handler.
   *
   * Never an issue/statement/deliberation id either — see the invariant 1 note
   * above. Null is correct when there is no single row: a bulk read, or a miss.
   */
  subjectRef?: string | null;
}

type VaultDb = ReturnType<typeof createVaultDbClient>;

/**
 * Appends one access-log row. Intentionally NOT fire-and-forget: a vault read
 * that succeeds while its audit record is silently lost is precisely the
 * failure this control exists to prevent, so callers await this and a failure
 * propagates.
 *
 * Emits a structured console.warn when a single call exposes more rows than
 * the configured threshold. That is the alerting hook — `wrangler tail` /
 * Workers Analytics can alarm on it (observability is enabled in
 * wrangler.jsonc). A real paging channel to founders is not wired yet; see
 * docs/vault-blast-radius.md.
 */
export async function logVaultAccess(
  db: VaultDb,
  env: Record<string, string | undefined>,
  entry: VaultAccessEntry,
): Promise<void> {
  await db.insert(schema.accessLog).values({
    operation: entry.operation,
    caller: entry.caller,
    outcome: entry.outcome,
    rowCount: entry.rowCount,
    subjectRef: entry.subjectRef ?? null,
  });

  const { vaultAccessAlertRowThreshold } = loadVaultAccessAlertConfig(env);
  if (entry.rowCount > vaultAccessAlertRowThreshold) {
    // No identity data in the alert payload — the point is that a bulk read
    // happened, not what it contained.
    console.warn(
      JSON.stringify({
        alert: "vault_bulk_access",
        operation: entry.operation,
        caller: entry.caller,
        rowCount: entry.rowCount,
        threshold: vaultAccessAlertRowThreshold,
      }),
    );
  }
}
