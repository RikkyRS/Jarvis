#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm run build
npm install -g .
echo "JARVIS on PATH. Test: jarvis doctor"
