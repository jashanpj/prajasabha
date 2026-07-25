#!/usr/bin/env bash
# Stop hook: fails if src/i18n/ml.json and en.json have mismatched keys.
# Flat-key comparison only; if i18n moves to nested namespaces this needs
# a recursive key-diff instead of `keys[]`.
set -euo pipefail

ML="apps/web/src/i18n/ml.json"
EN="apps/web/src/i18n/en.json"

[ -f "$ML" ] && [ -f "$EN" ] || exit 0

ml_keys="$(jq -r 'keys[]' "$ML" | sort)"
en_keys="$(jq -r 'keys[]' "$EN" | sort)"

if [ "$ml_keys" != "$en_keys" ]; then
  echo "i18n key mismatch between $ML and $EN (Malayalam is the default locale — both must stay in sync):" >&2
  diff <(echo "$ml_keys") <(echo "$en_keys") >&2 || true
  exit 2
fi

exit 0
