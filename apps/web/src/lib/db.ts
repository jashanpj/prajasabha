import { createDbClient } from "db";

/**
 * apps/web's runtime connection to packages/db. Connects as app_role — a
 * LOGIN role with no direct grants of its own, only membership in
 * service_role (packages/db/migrations/0002_grant_app_role_service_role.sql).
 * Postgres role membership inherits privileges by default (no explicit
 * SET ROLE needed): app_role automatically gets service_role's table
 * grants and RLS policy applicability for every query, so this is just
 * packages/db's own pooled client — verified against a real Postgres in
 * db.test.ts that app_role really does behave as service_role, and that
 * the append-only REVOKEs on event_log/moderation_actions still apply
 * regardless of how a session arrived at service_role's privileges.
 */
export function getServiceRoleDb(appDatabaseUrl: string) {
  return createDbClient(appDatabaseUrl);
}
