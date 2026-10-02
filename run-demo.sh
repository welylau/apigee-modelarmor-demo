#!/usr/bin/env bash
#
# run-demo.sh - brings up the Apigee Model Armor & Guardrails demonstration UI.
#
#   :8085  demo-ui/app.py   Chat playground + Admin analytics (stdlib only)
#
# Override the port with:  PORT=8080 ./run-demo.sh
# Stop with Ctrl-C.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_PORT="${PORT:-8085}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

echo -e "${BOLD}${BLUE}"
echo "=============================================================="
echo "  Apigee X · Model Armor · Guardrails Demo"
echo "=============================================================="
echo -e "${NC}"

# --- preflight -------------------------------------------------------------
if lsof -nP -iTCP:"${UI_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo -e "${RED}✖ Port ${UI_PORT} is already in use.${NC}"
  echo "  Free it with:  lsof -ti:${UI_PORT} | xargs kill"
  exit 1
fi

# --- API key ---------------------------------------------------------------
# The key is never stored in the repo. Use APIGEE_API_KEY if already exported,
# otherwise read it from Secret Manager (requires gcloud auth on the project).
GCP_PROJECT_ID="${GCP_PROJECT_ID:-YOUR_GCP_PROJECT_ID}"
APIGEE_KEY_SECRET="${APIGEE_KEY_SECRET:-apigee-modelarmor-demo-api-key}"
if [ -z "${APIGEE_API_KEY:-}" ]; then
  if ! APIGEE_API_KEY="$(CLOUDSDK_METRICS_ENVIRONMENT="datacloud.jetski" gcloud secrets versions access latest \
        --secret "${APIGEE_KEY_SECRET}" --project "${GCP_PROJECT_ID}" 2>/dev/null)"; then
    echo -e "${RED}✖ APIGEE_API_KEY is not set and secret '${APIGEE_KEY_SECRET}' could not be read.${NC}"
    echo "  Either: export APIGEE_API_KEY=...   or: gcloud auth login (with access to ${GCP_PROJECT_ID})"
    exit 1
  fi
fi
export APIGEE_API_KEY GCP_PROJECT_ID

# --- demo ui ---------------------------------------------------------------
echo -e "${GREEN}${BOLD}Starting demo UI${NC}  →  http://localhost:${UI_PORT}/"
echo -e "  ${YELLOW}Ctrl-C to stop.${NC}"
echo ""

cd "${ROOT}/demo-ui"
exec env PORT="${UI_PORT}" python3 app.py
