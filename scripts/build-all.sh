#!/usr/bin/env bash
# Build all platform release ZIPs (x64 + arm64 for Windows, Linux, macOS).
# Optional: pass --flatpak (or set WITH_FLATPAK=1) to also build Flatpak bundles.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET=all
for arg in "$@"; do
  case "$arg" in
    --flatpak|--with-flatpak|flatpak)
      TARGET=all-flatpak
      ;;
    --help|-h)
      echo "Usage: $0 [--flatpak]"
      echo "  Builds Windows/Linux/macOS × x64/arm64 release ZIPs."
      echo "  --flatpak  also builds linux x64 + arm64 Flatpak bundles."
      exit 0
      ;;
  esac
done

if [[ "${WITH_FLATPAK:-}" == "1" ]]; then
  TARGET=all-flatpak
fi

exec node build-exe.js --target "$TARGET"
