import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guard for issue #73's AC: "color tokens available as reusable
// tokens/CSS variables, not hardcoded hex per component." Reads every
// component's own <style> block and fails if a hex color appears outside
// a var(--...) reference — cheap, no visual-regression tooling needed.
const COMPONENTS_DIR = join(__dirname);
const HEX_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;

function extractStyleBlocks(source: string): string[] {
  return [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

describe("design-system components use tokens, not hardcoded hex", () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith(".astro"));
  expect(files.length).toBeGreaterThan(0);

  it.each(files)("%s has no hardcoded hex color in its <style> block", (file) => {
    const source = readFileSync(join(COMPONENTS_DIR, file), "utf-8");
    const styleBlocks = extractStyleBlocks(source);

    for (const block of styleBlocks) {
      // Strip every var(--token, #fallback) call before scanning — a hex
      // fallback inside var() is a token default, not a hardcoded color.
      const withoutVarCalls = block.replace(/var\([^)]*\)/g, "");
      const matches = withoutVarCalls.match(HEX_COLOR_PATTERN) ?? [];
      expect(matches, `${file} has hardcoded hex color(s): ${matches.join(", ")}`).toHaveLength(0);
    }
  });
});
