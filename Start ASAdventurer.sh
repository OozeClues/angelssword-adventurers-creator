#!/usr/bin/env bash
# ⚔️ AS Adventurer Creator — Linux / macOS launcher
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "  AS Adventurer Creator - VTuber Creation Pipeline"
echo "  ========================================="
echo "  Angel's Sword Studios"
echo "  Design - Generate - Prepare - Export"
echo ""
echo "  [Developer launcher — requires Node.js]"
echo "  End users should run the release package instead."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [ERROR] Node.js is not installed!"
  echo ""
  echo "  Install Node.js LTS from https://nodejs.org/"
  echo "  or via your package manager, then re-run this script."
  echo ""
  exit 1
fi

echo "  Node.js $(node --version) detected"

if [[ ! -d node_modules ]]; then
  echo ""
  echo "  First-time setup: Installing dependencies..."
  echo "  This only needs to happen once."
  echo ""
  npm install
  echo ""
  echo "  Dependencies installed successfully!"
fi

echo ""
echo "  Ensuring ffmpeg is available (transparent WebM export)..."
if ! node scripts/ensure-ffmpeg.js --quiet; then
  echo "  [WARN] ffmpeg could not be installed automatically."
  echo "  Transparent WebM export may be unavailable."
  echo "  GIF export still works. Re-run: npm install"
  echo ""
fi

echo ""
echo "  Starting server..."
echo "  (Press Ctrl+C to stop)"
echo ""
exec node server.js
