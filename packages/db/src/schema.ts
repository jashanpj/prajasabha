// Participation-DB schema (packages/db). Per CLAUDE.md's vault join rule,
// this file may only ever contain member_id + pseudonym + tier +
// constituency/ward — never identity attributes (name, phone, Aadhaar/EPIC).
//
// Scope: the 7 core tables from HLD §5 that issue #15 covers (members,
// issues, issue_support, authorities, routings, event_log,
// moderation_actions). Deliberation/panel/bill/RTI tables land per-module
// in later issues, per #15's "out of scope" note.
//
// RLS policies, role grants, and the append-only REVOKEs for event_log /
// moderation_actions are NOT expressed here — Drizzle's schema API has no
// concept of them. They live hand-appended in the generated migration SQL
// (packages/db/migrations/0000_init_participation_schema.sql), in the same
// file as the CREATE TABLE statements, per CLAUDE.md invariant 4.
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Postgres citext has no first-class Drizzle column type; this declares the
// SQL type directly so members.pseudonym gets case-insensitive uniqueness
// without an app-level lowercase() convention to forget.
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

export const memberTierEnum = pgEnum("member_tier", ["t0", "t1", "t2"]);
export const authorityKindEnum = pgEnum("authority_kind", [
  "councillor",
  "ulb",
  "mla",
  "mp",
  "dept",
  "agency",
]);
export const routingRoleEnum = pgEnum("routing_role", ["responsible", "copied"]);
// draft: not yet publicly visible; published: live, readable by anon;
// merged: superseded by another issue (see mergedInto); closed: lifecycle
// ended without a merge. Narrower than the full HLD timeline states —
// widen with a new migration if a story needs more.
export const issueStatusEnum = pgEnum("issue_status", ["draft", "published", "merged", "closed"]);
// Added in migration 0001 (issue #20's "Malayalam/English language
// choice" AC) — Malayalam is the default locale per CLAUDE.md.
export const localeEnum = pgEnum("locale", ["ml", "en"]);
// Added in migration 0009 (issue #35's C3 Deliberation Lifecycle).
export const deliberationStateEnum = pgEnum("deliberation_state", [
  "open",
  "extended",
  "closed",
  "summarized",
]);

export const members = pgTable(
  "members",
  {
    memberId: uuid("member_id").primaryKey().defaultRandom(),
    pseudonym: citext("pseudonym").notNull().unique(),
    tier: memberTierEnum("tier").notNull().default("t0"),
    constituencyId: uuid("constituency_id"),
    wardId: uuid("ward_id"),
    locale: localeEnum("locale").notNull().default("ml"),
    // Added in migration 0003 (issue #22's A3 EPIC/T2 verification). The
    // pilot targets a single Lok Sabha constituency, so — unlike
    // constituencyId/wardId above — there is no constituencies/wards lookup
    // table to FK against; assemblySegment is the reviewer-confirmed segment
    // name, and coverage is checked against a config-driven allow-list
    // (packages/shared's loadEpicVerificationConfig), same pattern as
    // concernThresholdT2. Both nullable: unset until a T2 approval happens.
    assemblySegment: text("assembly_segment"),
    assemblySegmentCovered: boolean("assembly_segment_covered"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Added in migration 0007 (issue #89's homepage "verified constituents"
  // count) — that query is a tier='t2' count(*) run on every homepage
  // load, including anonymous visitors; without this it was a full
  // sequential scan on every hit (security-reviewer finding).
  (t) => [index("members_tier_idx").on(t.tier)],
);

export const issues = pgTable(
  "issues",
  {
    issueId: uuid("issue_id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    titleMl: text("title_ml").notNull(),
    titleEn: text("title_en").notNull(),
    body: text("body").notNull(),
    // Data-driven taxonomy (HLD §6: router = SQL rules table, category x
    // ward -> authorities, editable in admin) — a TS enum here would force
    // a code deploy to add a category. Validated against a config-sourced
    // allow-list at the Zod boundary (packages/shared) instead.
    category: text("category").notNull(),
    wardId: uuid("ward_id").notNull(),
    status: issueStatusEnum("status").notNull().default("draft"),
    // Added in migration 0004 (issue #24's B1 photo upload). R2 object keys
    // (issues/{issueId}/{uuid}.{ext}) only — R2 is the blob store, PG is
    // the index (HLD §1). Bytes are EXIF/GPS-stripped by the endpoint
    // BEFORE the R2 put, so nothing location-bearing is ever persisted.
    // Capped at 5 keys, enforced at the endpoint (a CHECK on array length
    // would bake a product threshold into the schema — config, not DDL).
    photoKeys: text("photo_keys").array().notNull().default(sql`'{}'::text[]`),
    mergedInto: uuid("merged_into"),
    supportT2Count: integer("support_t2_count").notNull().default(0),
    // Added in migration 0006 (issue #27's B4 threshold promotion).
    // Orthogonal to `status` (visibility) — "Constituency Concern" is a
    // deliberation-eligibility classification a published issue gains once
    // supportT2Count crosses the configured threshold, not a new lifecycle
    // state. Non-null itself is the "not repeated on re-crossing" guard: a
    // single `UPDATE ... WHERE promoted_at IS NULL AND support_t2_count >=
    // threshold` is the atomic compare-and-swap that fires the promotion
    // event exactly once (see apps/web/src/pages/api/issues/[issueId]/support.ts).
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => members.memberId),
  },
  (t) => [
    index("issues_ward_idx").on(t.wardId),
    index("issues_status_idx").on(t.status),
    // Added in migration 0008 (issue #90's dashboard "Constituency
    // concerns" ranked-by-support list) — that query filters
    // status='published' then orders by supportT2Count desc on every
    // anonymous page load.
    index("issues_status_support_idx").on(t.status, t.supportT2Count),
  ],
);

export const issueSupport = pgTable(
  "issue_support",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.issueId),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    wardId: uuid("ward_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("issue_support_issue_member_uniq").on(t.issueId, t.memberId)],
);

export const authorities = pgTable("authorities", {
  authorityId: uuid("authority_id").primaryKey().defaultRandom(),
  kind: authorityKindEnum("kind").notNull(),
  nameMl: text("name_ml").notNull(),
  nameEn: text("name_en").notNull(),
});

export const routings = pgTable(
  "routings",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.issueId),
    authorityId: uuid("authority_id")
      .notNull()
      .references(() => authorities.authorityId),
    role: routingRoleEnum("role").notNull(),
    legalBasisRef: text("legal_basis_ref"),
  },
  // Added in migration 0008 (issue #90's dashboard) — issues/[slug].astro
  // and dashboard.astro both look up routings by issueId (a FK has no
  // implicit index in Postgres), and the dashboard's variant runs on every
  // anonymous homepage-adjacent load.
  (t) => [index("routings_issue_id_idx").on(t.issueId)],
);

// Added in migration 0005 (issue #25's B2 Responsibility Router). Pure
// category/ward/authority/legal-citation reference data — no identity
// attributes, so the vault join rule doesn't apply. Admin-maintained input
// to the router (HLD §6: "Router = SQL rules table ... editable in admin");
// its *output* (one `routings` row per match, computed at publish time) is
// what's ever public — this table itself gets service_role-only RLS, no
// anon/authenticated read policy at all (see migrations/0005_*.sql).
export const routingRules = pgTable("routing_rules", {
  ruleId: uuid("rule_id").primaryKey().defaultRandom(),
  // Free-text taxonomy, matches issues.category's allow-list-at-the-Zod-
  // boundary convention above — not a DB enum.
  category: text("category").notNull(),
  // NULL = applies to every ward in this single-constituency pilot; a
  // concrete wardId = ward-specific override/addition (e.g. a per-ward
  // Councillor rule alongside a wildcard ULB rule for the same category).
  wardId: uuid("ward_id"),
  authorityId: uuid("authority_id")
    .notNull()
    .references(() => authorities.authorityId),
  role: routingRoleEnum("role").notNull(),
  legalBasisRef: text("legal_basis_ref"),
});

// Added in migration 0009 (issue #35 — C3 Deliberation Lifecycle). A
// `deliberations` row is created only when an issue's supportT2Count
// crosses the concern threshold (see the atomic CAS transaction in
// apps/web/src/pages/api/issues/[issueId]/support.ts, which now also opens
// the deliberation in the same transaction as the promotion event) — the
// unique(issueId) constraint is a second guard against ever double-opening
// one, on top of that CAS. `state` is a state machine enforced in
// application code (packages/shared/src/deliberation-lifecycle.ts), not by
// a DB CHECK — Postgres can't express "valid transition from the row's
// current value" declaratively. extendedAt is unused until Module D
// (panel workspace, issue #43) lands the only thing that can set it;
// summaryArtifactKey is an R2 key (same "R2 is the blob store, PG is the
// index" pattern as issues.photoKeys), set once by the cron sweep
// (apps/jobs) on the closed->summarized transition.
export const deliberations = pgTable(
  "deliberations",
  {
    deliberationId: uuid("deliberation_id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.issueId),
    state: deliberationStateEnum("state").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    extendedAt: timestamp("extended_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    summarizedAt: timestamp("summarized_at", { withTimezone: true }),
    summaryArtifactKey: text("summary_artifact_key"),
  },
  (t) => [
    unique("deliberations_issue_id_uniq").on(t.issueId),
    // The cron sweep (apps/jobs) queries `state IN (...) AND closes_at <= now()`
    // on every run.
    index("deliberations_state_closes_at_idx").on(t.state, t.closesAt),
  ],
);

// Append-only (CLAUDE.md invariant 3): UPDATE/DELETE revoked from every
// role, including service_role, in the migration. Corrections are new rows,
// never edits — kind/subjectType stay free text since new event kinds are
// added continuously and payload (jsonb) already carries the structured
// detail.
export const eventLog = pgTable("event_log", {
  eventId: uuid("event_id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorMemberId: uuid("actor_member_id").references(() => members.memberId),
  kind: text("kind").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
});

// Append-only (CLAUDE.md invariant 3), same rationale as event_log. The
// moderation rulebook isn't defined yet, so ruleCited/action stay free text.
export const moderationActions = pgTable("moderation_actions", {
  actionId: uuid("action_id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  ruleCited: text("rule_cited").notNull(),
  action: text("action").notNull(),
  publicNote: text("public_note"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
