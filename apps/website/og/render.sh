#!/bin/sh
# Renders og/og.html -> public/og.png (1200x630 @2x) with headless Chrome.
# Re-run after editing og.html: pnpm --filter @rigkit/website og:render
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --force-device-scale-factor=2 --virtual-time-budget=5000 \
  --screenshot="$PWD/../public/og.png" "file://$PWD/og.html" 2>/dev/null
echo "wrote public/og.png"
