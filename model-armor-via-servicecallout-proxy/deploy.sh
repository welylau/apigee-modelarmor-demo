#!/usr/bin/env bash
# ==============================================================================
# Deploys model-armor-via-servicecallout-proxy and lets the existing demo app key call it.
#   1. stage the bundle, fill demo.properties (project, model, Model Armor template)
#   2. import + deploy to $APIGEE_ENV as the Apigee runtime SA (needs roles/modelarmor.user
#      and roles/aiplatform.user)
#   3. add this proxy to the API product apigee-model-armor-101-product (kept if already there),
#      so the key from ../web-ui/.env works here too
#
# Usage:  ARMOR_LOCATION=us-central1 ./model-armor-via-servicecallout-proxy/deploy.sh
# Overrides: PROJECT_ID APIGEE_ORG APIGEE_ENV MODEL ARMOR_PROJECT ARMOR_TEMPLATE PRODUCT
# Auth: Application Default Credentials (gcloud auth application-default login).
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
APIGEE_ORG="${APIGEE_ORG:-$PROJECT_ID}"
APIGEE_ENV="${APIGEE_ENV:-default-dev}"
MODEL="${MODEL:-gemini-2.5-flash-lite}"
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"
ARMOR_LOCATION="${ARMOR_LOCATION:-}"
ARMOR_TEMPLATE="${ARMOR_TEMPLATE:-apigee-model-armor-101}"
PRODUCT="${PRODUCT:-apigee-model-armor-101-product}"
PROXY="model-armor-via-servicecallout-proxy"
RUNTIME_SA="sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"

[[ "$ARMOR_LOCATION" =~ ^[a-z0-9-]+$ ]] || { echo "❌ Set ARMOR_LOCATION (e.g. ARMOR_LOCATION=us-central1 $0)" >&2; exit 1; }
for bin in apigeecli curl python3 gcloud; do command -v "$bin" >/dev/null || { echo "❌ $bin not found" >&2; exit 1; }; done
TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- 1. stage ----------
cp -R "$DIR/apiproxy" "$TMP/apiproxy"
PROPS="$TMP/apiproxy/resources/properties/demo.properties"
sed -i.bak -e "s|^vertex_project=.*|vertex_project=${PROJECT_ID}|" -e "s|^model=.*|model=${MODEL}|" \
  -e "s|^armor_project=.*|armor_project=${ARMOR_PROJECT}|" -e "s|^armor_location=.*|armor_location=${ARMOR_LOCATION}|" \
  -e "s|^armor_template=.*|armor_template=${ARMOR_TEMPLATE}|" "$PROPS" && rm -f "$PROPS.bak"

# ---------- 2. import + deploy ----------
echo "📦 Importing '$PROXY' (template: projects/$ARMOR_PROJECT/locations/$ARMOR_LOCATION/templates/$ARMOR_TEMPLATE)"
apigeecli apis create bundle -n "$PROXY" -f "$TMP/apiproxy" -o "$APIGEE_ORG" -t "$TOKEN" >/dev/null
echo "🚀 Deploying to '$APIGEE_ENV' as $RUNTIME_SA (waits for READY)"
apigeecli apis deploy -n "$PROXY" -e "$APIGEE_ENV" -s "$RUNTIME_SA" -o "$APIGEE_ORG" --ovr --wait -t "$TOKEN" >/dev/null
echo "✔ Proxy deployed"

# ---------- 3. add the proxy to the existing product ----------
code=$(curl -sS -o "$TMP/product.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/apiproducts/$PRODUCT")
[ "$code" = 200 ] || { echo "❌ product '$PRODUCT' not found (HTTP $code): run ./scripts/setup-apigee.sh first" >&2; exit 1; }
CHANGED=$(PROXY="$PROXY" python3 - "$TMP/product.json" <<'EOF'
import json, os, sys
p = json.load(open(sys.argv[1]))
cfgs = p.setdefault("operationGroup", {}).setdefault("operationConfigs", [])
if any(c.get("apiSource") == os.environ["PROXY"] for c in cfgs):
    print("no")
else:
    cfgs.append({"apiSource": os.environ["PROXY"], "operations": [{"resource": "/**"}]})
    json.dump(p, open(sys.argv[1], "w"))
    print("yes")
EOF
)
if [ "$CHANGED" = yes ]; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data @"$TMP/product.json" "$API/apiproducts/$PRODUCT")
  [ "$code" = 200 ] || { echo "❌ update product (HTTP $code)" >&2; exit 1; }
  echo "➕ Added '$PROXY' to product '$PRODUCT'"
else
  echo "✔ Product '$PRODUCT' already includes '$PROXY'"
fi
echo "✅ Done: POST https://<APIGEE_HOST>/model-armor-via-servicecallout/generate (header x-api-key)"
