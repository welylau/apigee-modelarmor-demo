#!/usr/bin/env bash
# ==============================================================================
# Runs the Model Armor 101 web UI locally.
#   ./run-local.sh                 # uses .env (API_KEY etc.)
#   DEMO_MOCK=1 ./run-local.sh     # fake gateway results, no Apigee needed
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load API_KEY and overrides from .env (written by ../scripts/setup-apigee.sh; never commit it).
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

if [ -z "${PORT:-}" ]; then
  if lsof -i :8080 >/dev/null 2>&1; then PORT=8081; else PORT=8080; fi
fi
# Local-only by default. Set HOST=0.0.0.0 explicitly to expose on the network.
HOST="${HOST:-127.0.0.1}"
export PORT HOST

case "${APIGEE_HOST:-YOUR_APIGEE_HOST}" in
  *.nip.io) export APIGEE_INSECURE="${APIGEE_INSECURE:-1}" ;;
esac

echo "=================================================================="
echo "▶ Model Armor and Apigee Demo UI: http://localhost:${PORT}  (bound to ${HOST})"
[ "${DEMO_MOCK:-0}" = "1" ] && echo "  DEMO_MOCK=1: gateway calls are simulated"
echo "=================================================================="
exec python3 "$DIR/server.py"
