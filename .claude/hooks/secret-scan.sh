#!/usr/bin/env bash
# PreToolUse hook (Edit|Write): blocks writes containing likely secrets or
# Aadhaar-like 12-digit literals. Best-effort — not a substitute for
# gitleaks' full-history scan in CI, which is the real backstop.
set -euo pipefail

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
content="$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // empty')"
[ -z "$file_path" ] && exit 0
[ -z "$content" ] && exit 0

# Aadhaar-like: 12 digits, optionally grouped as 4-4-4.
if printf '%s' "$content" | grep -Eq '[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}'; then
  echo "Blocked: '$file_path' contains a 12-digit literal that looks like an Aadhaar/EPIC-style ID. Use a masked or clearly-fake generator in fixtures." >&2
  exit 2
fi

if command -v gitleaks >/dev/null 2>&1; then
  tmpfile="$(mktemp)"
  trap 'rm -f "$tmpfile"' EXIT
  printf '%s' "$content" > "$tmpfile"
  out="$(gitleaks detect --no-git --source "$tmpfile" -v 2>&1 || true)"
  if printf '%s' "$out" | grep -qi "leak"; then
    echo "Blocked: gitleaks flagged a potential secret in '$file_path'." >&2
    echo "$out" >&2
    exit 2
  fi
fi

exit 0
