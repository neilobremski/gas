#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="${SCRIPT_DIR}/pii-patterns.local.txt"

if [ ! -f "${LOCAL}" ]; then
  echo "sync-pii-patterns: missing ${LOCAL}" >&2
  echo "  cp .github/pii-patterns.example.txt .github/pii-patterns.local.txt" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "sync-pii-patterns: gh CLI not found (https://cli.github.com/)" >&2
  exit 1
fi

gh secret set PII_PATTERNS < "${LOCAL}"
count="$(grep -cve '^\s*\(#\|$\)' "${LOCAL}" || true)"
echo "Synced PII_PATTERNS -> GitHub Actions secret (${count} pattern(s) from pii-patterns.local.txt)"
