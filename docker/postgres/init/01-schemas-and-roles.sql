-- Local dev bootstrap for the docker-compose Postgres (issue #14).
--
-- Provisions the sandbox: extensions, schemas, and LOGIN roles. It does NOT
-- create application tables, RLS policies, or the anon/authenticated/
-- service_role grantee roles — those come from packages/db's own migration
-- (issue #15), because that migration is the only artifact that runs
-- identically here and against CI's bare `postgres:16` service (which has
-- no init-script mechanism at all).
--
-- Passwords below are dev-only, fixed, and meaningless outside a throwaway
-- local container nobody exposes beyond localhost — this does not violate
-- CLAUDE.md invariant 6 ("no secrets... in code"), which governs real
-- credentials (those live in Wrangler secrets / KV, never here or in any
-- deployed environment). Anyone can read this file; that's the point.

-- citext is needed for members.pseudonym (case-insensitive uniqueness).
-- Also created defensively inside the #15 migration itself, since CI's
-- service container has no init script to run this file at all.
CREATE EXTENSION IF NOT EXISTS citext;

-- Two schemas, one per side of the vault join rule:
--   public — participation DB (packages/db): member_id + pseudonym + tier +
--            constituency/ward only, never identity attributes.
--   vault  — identity vault (packages/vault-db, schema itself lands in #16):
--            verification records, never civic-activity attributes.
CREATE SCHEMA IF NOT EXISTS vault;

-- Two LOGIN roles, one per schema, with no cross-schema grants. This makes
-- the vault join rule a real Postgres permission boundary locally, not just
-- a convention nobody enforces: a query issued as app_role against vault.*
-- fails outright, and vice versa.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN PASSWORD 'app_role_dev_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_role') THEN
    CREATE ROLE vault_role LOGIN PASSWORD 'vault_role_dev_only';
  END IF;
END
$$;

GRANT ALL ON SCHEMA public TO app_role;
REVOKE ALL ON SCHEMA vault FROM app_role;

GRANT ALL ON SCHEMA vault TO vault_role;
REVOKE ALL ON SCHEMA public FROM vault_role;

-- Default privileges so future tables created by each role's own migrations
-- inherit the same isolation without a manual GRANT per table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA vault GRANT ALL ON TABLES TO vault_role;
