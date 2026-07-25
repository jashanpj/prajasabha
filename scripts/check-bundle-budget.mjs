#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
// Fails if any client-side route JS exceeds the 50KB (gzip) budget cited in
// docs/dev-process-playbook.md — STACK.md, the doc that originally set this
// number, was never committed to this repo (see #13's plan notes), so 50KB
// is the only in-repo source of truth for the figure.
//
// Expects apps/web/dist/client/_astro to already exist — ci.yml runs the
// Playwright smoke step (which builds apps/web via its webServer) before
// this script. Run `pnpm --filter web run build` first if running locally.
import { gzipSync } from "node:zlib";

const BUDGET_BYTES = 50 * 1024;
const CLIENT_DIR = resolve("apps/web/dist/client");
const ASTRO_CLIENT_DIR = join(CLIENT_DIR, "_astro");

if (!existsSync(CLIENT_DIR)) {
  console.error(
    `${CLIENT_DIR} does not exist. Build apps/web first (pnpm --filter web run build).`,
  );
  process.exit(1);
}

// No _astro dir at all means zero client-side JS was emitted (e.g. no page
// uses a hydrated island yet) — budget trivially satisfied.
const jsFiles = existsSync(ASTRO_CLIENT_DIR)
  ? readdirSync(ASTRO_CLIENT_DIR).filter((f) => extname(f) === ".js")
  : [];

if (jsFiles.length === 0) {
  console.log("No client JS chunks emitted — nothing to budget-check.");
  process.exit(0);
}

const overBudget = [];

for (const file of jsFiles) {
  const path = join(ASTRO_CLIENT_DIR, file);
  const gzipSize = gzipSync(readFileSync(path)).length;
  if (gzipSize > BUDGET_BYTES) {
    overBudget.push({ file, gzipSize });
  }
}

if (overBudget.length > 0) {
  console.error(`Bundle-size budget exceeded (${BUDGET_BYTES / 1024}KB gzip per chunk):`);
  for (const { file, gzipSize } of overBudget) {
    console.error(`  ${file}: ${(gzipSize / 1024).toFixed(1)}KB`);
  }
  process.exit(1);
}

console.log(
  `Bundle-size budget ok (${jsFiles.length} chunk(s), largest under ${BUDGET_BYTES / 1024}KB gzip)`,
);
