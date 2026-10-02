#!/usr/bin/env bash
# Build + deploy StaticGuardrails (SharedFlow + env-scoped property set "sg") and guardrail-proxy.
# Usage: ./StaticGuardrails/deploy.sh [org] [env]
# The property set is ENVIRONMENT-scoped: property sets bundled in a SharedFlow are not readable via
# propertyset.sg.* on Apigee X. To update only the word lists, edit src/sg.properties.src and run with
# ONLY_PROPS=1 (no SharedFlow redeploy needed).
set -euo pipefail

ORG="${1:-YOUR_GCP_PROJECT_ID}"
ENV="${2:-default-dev}"
SA="sa-apigee-aiservices@${ORG}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

python3 "$HERE/build.py"

# Create or update the env-scoped property set.
if apigeecli res get -n sg -p properties -e "$ENV" -o "$ORG" --default-token >/dev/null 2>&1; then
  apigeecli res update -n sg -p properties --respath "$HERE/env/sg.properties" -e "$ENV" -o "$ORG" --default-token
else
  apigeecli res create -n sg -p properties --respath "$HERE/env/sg.properties" -e "$ENV" -o "$ORG" --default-token
fi

if [[ "${ONLY_PROPS:-0}" == "1" ]]; then
  echo "Property set updated (takes effect within ~1 min)."
  exit 0
fi

apigeecli sharedflows create bundle -n StaticGuardrails -f "$HERE/sharedflowbundle" \
  -e "$ENV" -s "$SA" --ovr --wait -o "$ORG" --default-token

apigeecli apis create bundle -n guardrail-proxy -f "$ROOT/guardrail-proxy/apiproxy" \
  -e "$ENV" -s "$SA" --ovr --wait -o "$ORG" --default-token
