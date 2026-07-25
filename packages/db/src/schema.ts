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

export const members = pgTable("members", {
  memberId: uuid("member_id").primaryKey().defaultRandom(),
  pseudonym: citext("pseudonym").notNull().unique(),
  tier: memberTierEnum("tier").notNull().default("t0"),
  constituencyId: uuid("constituency_id"),
  wardId: uuid("ward_id"),
  locale: localeEnum("locale").notNull().default("ml"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    mergedInto: uuid("merged_into"),
    supportT2Count: integer("support_t2_count").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => members.memberId),
  },
  (t) => [index("issues_ward_idx").on(t.wardId), index("issues_status_idx").on(t.status)],
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

export const routings = pgTable("routings", {
  issueId: uuid("issue_id")
    .notNull()
    .references(() => issues.issueId),
  authorityId: uuid("authority_id")
    .notNull()
    .references(() => authorities.authorityId),
  role: routingRoleEnum("role").notNull(),
  legalBasisRef: text("legal_basis_ref"),
});

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
