#!/usr/bin/env node
// CI counterpart to .claude/hooks/verify-i18n.sh — same flat-key comparison,
// standalone Node so it doesn't depend on jq being present on the runner.
// Flat-key only; if i18n moves to nested namespaces this needs a recursive
// key-diff instead of Object.keys().
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ML = "apps/web/src/i18n/ml.json";
const EN = "apps/web/src/i18n/en.json";

function readKeys(path) {
  const raw = readFileSync(resolve(path), "utf-8");
  return Object.keys(JSON.parse(raw)).sort();
}

const mlKeys = readKeys(ML);
const enKeys = readKeys(EN);

const missingInEn = mlKeys.filter((k) => !enKeys.includes(k));
const missingInMl = enKeys.filter((k) => !mlKeys.includes(k));

if (missingInEn.length > 0 || missingInMl.length > 0) {
  console.error(
    `i18n key mismatch between ${ML} and ${EN} (Malayalam is the default locale — both must stay in sync):`,
  );
  if (missingInEn.length > 0) {
    console.error(`  present in ${ML}, missing from ${EN}: ${missingInEn.join(", ")}`);
  }
  if (missingInMl.length > 0) {
    console.error(`  present in ${EN}, missing from ${ML}: ${missingInMl.join(", ")}`);
  }
  process.exit(1);
}

console.log(`i18n parity ok (${mlKeys.length} keys)`);
