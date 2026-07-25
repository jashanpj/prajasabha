/// <reference types="astro/client" />

// No Worker bindings yet (KV/D1/R2 land with the stories that need them).
// Regenerate via `wrangler types` once wrangler.jsonc declares any.
type Env = Record<string, never>;

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
