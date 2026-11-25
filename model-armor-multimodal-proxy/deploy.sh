#!/usr/bin/env bash
# ==============================================================================
# Deploys model-armor-multimodal-proxy and lets the existing demo app key call it.
#   1. stage the bundle, fill demo.properties (project, Model Armor location)
#   2. import + deploy to $APIGEE_ENV as the Apigee runtime SA (needs roles/modelarmor.user
#      and roles/aiplatform.user)
#   3. add this proxy to the API product apigee-model-armor-101-product (kept if already there),
#      so the key from ../web-ui/.env works here too
#
# Prerequisite: ./scripts/setup-model-armor-multimodal.sh (templates in a location with image support).
# Usage:  ./model-armor-multimodal-proxy/deploy.sh
# Overrides: PROJECT_ID APIGEE_ORG APIGEE_ENV ARMOR_PROJECT MM_LOCATION PRODUCT
#   ARMOR_PROJECT  project of the Model Armor templates (default PROJECT_ID)
#   MM_LOCATION    Model Armor template location (default us); ARMOR_LOCATION is accepted as an
#                  alias when MM_LOCATION is unset. Images need a multi-region: us, eu or global.
# Auth: Application Default Credentials (gcloud auth application-default login).
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
APIGEE_ORG="${APIGEE_ORG:-$PROJECT_ID}"
APIGEE_ENV="${APIGEE_ENV:-default-dev}"
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"
MM_LOCATION="${MM_LOCATION:-${ARMOR_LOCATION:-us}}"
PRODUCT="${PRODUCT:-apigee-model-armor-101-product}"
PROXY="model-armor-multimodal-proxy"
RUNTIME_SA="sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
API="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"

# Never deploy a sanitized tree (YOUR_* placeholders from ./sanitize.sh), same as scripts/setup-apigee.sh.
if [ -f "$ROOT/.sanitize.state" ] && grep -q sanitized "$ROOT/.sanitize.state"; then
  echo "❌ Repo is sanitized (YOUR_* placeholders). Run ./restore.sh first." >&2; exit 1
fi
[[ "$MM_LOCATION" =~ ^[a-z0-9-]+$ ]] || { echo "❌ invalid MM_LOCATION" >&2; exit 1; }
[[ "$ARMOR_PROJECT" =~ ^[a-z0-9.:-]+$ ]] || { echo "❌ invalid ARMOR_PROJECT" >&2; exit 1; }
case "$MM_LOCATION" in us|eu|global) ;; *) echo "⚠️  MM_LOCATION=$MM_LOCATION: image screening needs us, eu or global" >&2 ;; esac
for bin in apigeecli curl python3 gcloud; do command -v "$bin" >/dev/null || { echo "❌ $bin not found" >&2; exit 1; }; done
TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- 1. stage ----------
cp -R "$DIR/apiproxy" "$TMP/apiproxy"
PROPS="$TMP/apiproxy/resources/properties/demo.properties"
sed -i.bak -e "s|^vertex_project=.*|vertex_project=${PROJECT_ID}|" -e "s|^armor_project=.*|armor_project=${ARMOR_PROJECT}|" \
  -e "s|^armor_location=.*|armor_location=${MM_LOCATION}|" "$PROPS" && rm -f "$PROPS.bak"

# ---------- 2. import + deploy ----------
echo "📦 Importing '$PROXY' (Model Armor location: $MM_LOCATION)"
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
echo "✅ Done: POST https://<APIGEE_HOST>/model-armor-multimodal/generate and /generate-image (header x-api-key)"
