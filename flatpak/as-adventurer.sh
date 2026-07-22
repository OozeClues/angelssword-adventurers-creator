#!/usr/bin/env bash
# Flatpak entrypoint — runs the packaged local server + browser UI.
set +e
APP_ROOT="/app/lib/as-adventurer"
cd "$APP_ROOT" || exit 1

export PATH="$APP_ROOT/bin:${PATH}"

echo ""
echo "  AS Adventurer Creator — Angel's Sword Studios"
echo "  Starting… leave this window open. Ctrl+C to stop."
echo "  UI: http://localhost:3001"
echo ""

# ffmpeg is downloaded on first run into the user cache when not bundled.
if [[ ! -x "$APP_ROOT/bin/ffmpeg" ]]; then
  echo "  ffmpeg: not bundled — app will download on first use if needed."
fi

# Prefer the portal-backed host browser (Flatpak sandbox).
(sleep 1.5; command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:${PORT:-3001}") &

# Avoid a second browser tab from the bundled server if it honors SKIP_BROWSER.
export SKIP_BROWSER=1
exec "$APP_ROOT/ASAdventurer"
