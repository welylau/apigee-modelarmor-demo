#!/bin/bash
# Renders docs/architecture-diagram.html -> docs/architecture.png (1600x900 @2x = 3200x1800), the source of truth,
# and copies it to <web dir>/static/assets/architecture.png (served to the Web UI architecture modal).
# The gcloud project id is swapped for YOUR_PROJECT_ID in a temp copy first, so the PNG never holds real values.
# Env: CHROME (browser binary), PROJECT_ID (value to hide), WEB_DIR (default: web-ui, else WebUI).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="$DIR/docs/architecture-diagram.html"
OUT="$DIR/docs/architecture.png"
WEB_DIR="${WEB_DIR:-$( [ -d "$DIR/web-ui" ] && echo web-ui || echo WebUI )}"
WEB="$DIR/$WEB_DIR/static/assets/architecture.png"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME (set CHROME=...)" >&2; exit 1; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
# Same directory as the source so relative icon paths (../web-ui/static/assets/...) resolve.
TMP="$DIR/docs/.architecture-render.tmp.html"
trap 'rm -f "$TMP"' EXIT
if [ -n "$PROJECT_ID" ]; then
  sed "s/${PROJECT_ID}/YOUR_PROJECT_ID/g" "$SRC" > "$TMP"
else
  cp "$SRC" "$TMP"
fi

# --virtual-time-budget lets the web fonts load before the screenshot.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2 --window-size=1600,900 --virtual-time-budget=3000 \
  --screenshot="$OUT" "file://$TMP" >/dev/null 2>&1
[ -s "$OUT" ] || { echo "render failed: $OUT is empty" >&2; exit 1; }
mkdir -p "$(dirname "$WEB")"
cp "$OUT" "$WEB"
echo "Wrote $OUT and $WEB"
