#!/usr/bin/env bash
# PreToolUse hook (Edit|Write): blocks edits to already-committed migrations
# and to packages/vault-db, unless explicitly opted in via PRAJA_VAULT_WORK=1.
set -euo pipefail

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file_path" ] && exit 0

rel_path="${file_path#"$(pwd)/"}"

is_existing_migration=false
if [[ "$rel_path" == *packages/db/migrations/* ]] && git ls-files --error-unmatch "$rel_path" >/dev/null 2>&1; then
  is_existing_migration=true
fi

if [ "$is_existing_migration" = true ]; then
  echo "Blocked: '$rel_path' is a committed migration. Migrations are append-only — add a new migration file instead of editing this one." >&2
  exit 2
fi

if [[ "$rel_path" == *packages/vault-db/* ]] && [ "${PRAJA_VAULT_WORK:-}" != "1" ]; then
  echo "Blocked: '$rel_path' is under packages/vault-db. Set PRAJA_VAULT_WORK=1 to work here deliberately — this package holds identity data and edits need extra scrutiny." >&2
  exit 2
fi

exit 0
