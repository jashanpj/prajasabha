import { Hono } from "hono";

// Public open-data API (/v1) — read-only, API-keyed, separately rate-limited
// from apps/web per HLD §3. No mutation routes belong here; all writes go
// through apps/web's Astro API endpoints per CLAUDE.md invariant 5.
const app = new Hono();

app.get("/v1/health", (c) => c.json({ status: "ok" }));

export default app;
