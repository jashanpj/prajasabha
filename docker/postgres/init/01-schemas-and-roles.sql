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

-- app_role deliberately gets NO direct grant on schema public or any of
-- its tables (issue #20): it exists only to log in and immediately
-- `SET ROLE service_role`, so every actual query runs under
-- service_role's own grants/RLS policies from
-- packages/db/migrations/0000 + 0002, not as a superuser-adjacent
-- identity with its own standing access. An earlier version of this file
-- granted app_role table-level ALL by default, which RLS's zero-policy
-- default-deny happened to neuter for SELECT (rows filtered to empty)
-- but would have surfaced confusingly for INSERT/UPDATE/DELETE — removed
-- rather than relied on RLS alone to paper over it.
REVOKE ALL ON SCHEMA vault FROM app_role;

GRANT ALL ON SCHEMA vault TO vault_role;
REVOKE ALL ON SCHEMA public FROM vault_role;

-- vault_role's actual table grants (SELECT/INSERT/UPDATE, no DELETE) come
-- exclusively from packages/vault-db/migrations/0000 — no default-privilege
-- shortcut here, so the migration stays the single source of truth for
-- exactly what vault_role can do.
