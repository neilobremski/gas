#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Installing dependencies and vendoring marked..."
npm ci
npm run vendor

echo "Running tests..."
tests/run

echo "Pushing to Google Apps Script..."
clasp push

echo "Done."
