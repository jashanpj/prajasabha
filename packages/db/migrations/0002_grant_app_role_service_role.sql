-- Runtime write path for issue #20's registration endpoint (and every
-- future mutation endpoint): apps/web connects as app_role — a LOGIN role
-- that already exists in local dev (docker-compose's
-- docker/postgres/init/01-schemas-and-roles.sql, password
-- 'app_role_dev_only' — dev-only, documented, not a real secret) — with
-- NO direct grants of its own. The GRANT below makes app_role a MEMBER of
-- service_role; Postgres role membership INHERITS privileges by default
-- (no explicit SET ROLE needed), so every query app_role runs is
-- automatically checked under service_role's own FOR ALL / append-only-safe
-- policies and grants from migration 0000, not as a superuser bypassing
-- RLS entirely — verified end-to-end in apps/web/src/lib/db.test.ts. CI's
-- bare postgres:16 has no init-script mechanism, so this migration also
-- creates app_role idempotently, matching 0000's existing pattern for
-- anon/authenticated/service_role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN PASSWORD 'app_role_dev_only';
  END IF;
END
$$;
--> statement-breakpoint
GRANT service_role TO app_role;
