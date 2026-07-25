import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

// React (@astrojs/react) is intentionally not wired in yet — no page uses
// an island, and registering the integration unconditionally shipped a
// ~59KB gzip React runtime to every page load, blowing the bundle-size
// budget. Add it back in whichever story first needs client:* hydration,
// per CLAUDE.md's "justify any client:load in the PR description" rule.
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
});
