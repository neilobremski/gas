#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="${ROOT}/.github/hooks/pre-push"
GIT_HOOK="${ROOT}/.git/hooks/pre-push"

if [ ! -d "${ROOT}/.git" ]; then
  echo "install-hooks: not a git repository: ${ROOT}" >&2
  exit 1
fi

chmod +x "${HOOK_SRC}"
ln -sf "../../.github/hooks/pre-push" "${GIT_HOOK}"

echo "Installed pre-push hook -> ${GIT_HOOK}"

if [ ! -f "${ROOT}/.github/pii-patterns.local.txt" ]; then
  echo ""
  echo "Next: copy and customize local PII patterns (gitignored):"
  echo "  cp .github/pii-patterns.example.txt .github/pii-patterns.local.txt"
  echo "  .github/sync-pii-patterns.sh   # push patterns to GitHub Actions secret"
fi
