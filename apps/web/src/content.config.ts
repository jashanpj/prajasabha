// Astro Content Collections config (Astro 6, `src/content.config.ts` — the
// current convention; NOT the legacy `src/content/config.ts`). First use of
// Content Collections in apps/web, per docs/technical-architecture-hld.md
// §6 ("Router = SQL rules table ... editable in admin; explainers in
// Content Collections") — issue #25 (B2, Responsibility Router).
//
// `routingExplainers` is static bilingual legal-basis explainer copy, one
// entry per authority/legal-basis, entirely separate from the `routings`
// DB table it's paired with at render time (packages/db knows only
// member_id + pseudonym + tier + constituency/ward — CLAUDE.md's vault
// join rule — this collection carries no identity or civic-activity data
// at all, so it's outside that rule's scope entirely).
//
// Loader choice: `glob` over one JSON file per entry, keyed by filename —
// the filename doubles as the entry's `id`, which callers set to the exact
// `routing_rules.legal_basis_ref` slug value (e.g.
// `kerala-municipality-act-1994.json` -> id `kerala-municipality-act-1994`).
// Preferred over a single `file` loader with one big JSON blob because a
// new legal-basis explainer is then a new file, not an edit to a shared
// array — smaller diffs, no merge conflicts between unrelated explainers.
// Works fine under `output: "server"` — content collections are resolved
// at build time regardless of the SSR adapter.
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const routingExplainers = defineCollection({
  loader: glob({ pattern: "*.json", base: "./src/content/routing-explainers" }),
  schema: z.object({
    titleMl: z.string(),
    titleEn: z.string(),
    bodyMl: z.string(),
    bodyEn: z.string(),
  }),
});

export const collections = { routingExplainers };
