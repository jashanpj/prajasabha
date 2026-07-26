CREATE TABLE "routing_rules" (
	"rule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"ward_id" uuid,
	"authority_id" uuid NOT NULL,
	"role" "routing_role" NOT NULL,
	"legal_basis_ref" text
);
--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_authority_id_authorities_authority_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."authorities"("authority_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Row-level security (CLAUDE.md invariants 3 and 4 — RLS + policy in the
-- same migration as the CREATE TABLE, no exceptions, including lookup
-- tables). Unlike `authorities`/`routings` (public-read, see migration
-- 0000), `routing_rules` is internal admin-maintained routing config — it
-- is never rendered directly, only its *output* (a `routings` row inserted
-- at publish time) is public. So it gets NO anon/authenticated SELECT
-- policy at all: zero policies for those roles is default-deny. Only
-- service_role (Astro API endpoints computing routing at publish time)
-- ever reads or writes it.
ALTER TABLE "routing_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "service_role_all_routing_rules" ON "routing_rules" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "routing_rules" TO service_role;--> statement-breakpoint
-- Seed reference data (issue #25 pilot demo): plain public reference data
-- (authority names, routing rules) — not a secret/threshold (CLAUDE.md
-- invariant 6 doesn't apply), so it's fine to hardcode as seed SQL here,
-- same pattern as this migration itself being the only sanctioned way to
-- change schema/seed state (no seed-script mechanism exists yet).
--
-- Ward uuids below match PILOT_WARD_IDS / the DEV_WARDS fallback used by
-- apps/web/src/pages/issues/new.astro, so routing actually lines up with
-- what a demo user picks on the raise-issue form. legal_basis_ref slugs
-- match the bilingual explainer content keyed by these exact strings.
--
-- This seed set is deliberately designed so publishing a 'roads' issue in
-- either pilot ward produces THREE routings: a ward-specific Councillor +
-- a wildcard ULB (both 'responsible' — the multi-authority fan-out case),
-- plus a wildcard MP 'copied' (the copied-for-information case).
WITH seeded_authorities AS (
	INSERT INTO "authorities" ("kind", "name_ml", "name_en") VALUES
		('councillor', 'വാർഡ് 1 കൗൺസിലർ', 'Ward 1 Councillor'),
		('councillor', 'വാർഡ് 2 കൗൺസിലർ', 'Ward 2 Councillor'),
		('ulb', 'നഗരസഭ / പഞ്ചായത്ത്', 'Municipality / Panchayat'),
		('mla', 'എംഎൽഎ ഓഫീസ്', 'MLA Office'),
		('mp', 'എംപി ഓഫീസ്', 'MP Office'),
		('agency', 'വൈദ്യുതി ബോർഡ് (കെഎസ്ഇബി)', 'Electricity Board (KSEB)')
	RETURNING "authority_id", "name_en"
)
INSERT INTO "routing_rules" ("category", "ward_id", "authority_id", "role", "legal_basis_ref")
SELECT 'roads', '3fa85f64-5717-4562-b3fc-2c963f66afa6'::uuid, "authority_id", 'responsible'::"routing_role", 'kerala-municipality-act-1994'
FROM seeded_authorities WHERE "name_en" = 'Ward 1 Councillor'
UNION ALL
SELECT 'roads', '5b1b6e1e-1c1a-4e1a-9c1a-2c963f66afa6'::uuid, "authority_id", 'responsible'::"routing_role", 'kerala-municipality-act-1994'
FROM seeded_authorities WHERE "name_en" = 'Ward 2 Councillor'
UNION ALL
SELECT 'roads', NULL::uuid, "authority_id", 'responsible'::"routing_role", 'kerala-municipality-act-1994'
FROM seeded_authorities WHERE "name_en" = 'Municipality / Panchayat'
UNION ALL
SELECT 'roads', NULL::uuid, "authority_id", 'copied'::"routing_role", 'mp-copied-for-information'
FROM seeded_authorities WHERE "name_en" = 'MP Office'
UNION ALL
SELECT 'water', NULL::uuid, "authority_id", 'responsible'::"routing_role", 'kerala-municipality-act-1994'
FROM seeded_authorities WHERE "name_en" = 'Municipality / Panchayat'
UNION ALL
SELECT 'electricity', NULL::uuid, "authority_id", 'responsible'::"routing_role", 'electricity-supply-code'
FROM seeded_authorities WHERE "name_en" = 'Electricity Board (KSEB)';