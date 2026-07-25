#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): auto-formats with Biome once the monorepo
# actually has pnpm + a biome config. No-ops until then, so this doesn't
# spam errors before the app skeleton exists.
set -euo pipefail

command -v pnpm >/dev/null 2>&1 || exit 0
[ -f biome.json ] || [ -f biome.jsonc ] || exit 0
[ -z "${CLAUDE_FILE_PATHS:-}" ] && exit 0

pnpm biome check --write --no-errors-on-unmatched $CLAUDE_FILE_PATHS 2>/dev/null || true
exit 0
