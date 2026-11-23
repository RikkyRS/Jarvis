#!/usr/bin/env bash
# Reproducible CLI tour of JARVIS on a throwaway repository. Run after `npm run build`.
set -euo pipefail
JARVIS="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli/main.js"
DEMO="$(mktemp -d)"
trap 'rm -rf "$DEMO"' EXIT
cd "$DEMO"
git init -q -b main && git config user.email demo@example.com && git config user.name Demo
echo "demo" > README.md && git add . && git commit -qm "init"

step() { printf '\n\033[1m$ jarvis %s\033[0m\n' "$*"; }
run() { step "$@"; $JARVIS "$@"; }

run status
run work create "Fix totals" --objective "Report totals ignore discounts" --accept "totals match the invoice"
run work list
MISSION=$($JARVIS mission create | grep -Eo 'mis_[0-9a-f-]+' | head -1)
step "mission create   # -> $MISSION"
run budget grant "$MISSION" EXECUTION 80000 --reason "approved scope v1"
run budget status "$MISSION" EXECUTION
run scan
run audit verify
