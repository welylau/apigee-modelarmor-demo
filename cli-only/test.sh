#!/usr/bin/env bash
# ==============================================================================
# Live tests for the CLI variant.
#   [1] both proxies reject a missing API key with 401 JSON
#   [2] every scenario on both proxies gives the expected verdict and filter (ma101.py --check)
# ==============================================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }
HOST="${APIGEE_HOST:-YOUR_APIGEE_HOST}"; HOST="${HOST#https://}"; HOST="${HOST%/}"
K=(); case "$HOST" in *.nip.io) K=(-k) ;; esac; [ "${APIGEE_INSECURE:-0}" = 1 ] && K=(-k)
FAIL=0

echo "🧪 [1] missing API key -> 401"
for P in model-armor-101-native model-armor-101-callout; do
  code=$(curl -sS "${K[@]+"${K[@]}"}" -o /dev/null -w '%{http_code}' -X POST "https://$HOST/$P/generate" \
    -H "Content-Type: application/json" -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}') || code=000
  if [ "$code" = 401 ]; then echo "  ✅ $P 401"; else echo "  ❌ $P got $code (000 = unreachable, 404 = not deployed)"; FAIL=1; fi
done

echo "🧪 [2] all scenarios x both proxies"
NO_COLOR=1 python3 "$DIR/ma101.py" -s all -p both --check | tail -9 || FAIL=1

[ "$FAIL" = 0 ] && echo "✅ ALL PASSED" || echo "❌ FAILURES"
exit "$FAIL"
