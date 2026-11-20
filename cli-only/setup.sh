#!/usr/bin/env bash
# ==============================================================================
# Model Armor 101 (CLI): deploy both proxies + one product/app/key.
#   1. import + deploy model-armor-101-native and model-armor-101-callout to $APIGEE_ENV
#      (deployment service account = $RUNTIME_SA; needs aiplatform.user + modelarmor.user/viewer)
#   2. API product model-armor-101-cli-product covering BOTH proxies
#   3. developer model-armor-101-cli@example.com + app model-armor-101-cli
#   4. write cli-only/.env (API_KEY + template settings, chmod 600); key printed masked
#
# Prereq: the Model Armor template exists (../scripts/setup-model-armor.sh creates it).
# Usage:  ARMOR_LOCATION=us-central1 ./setup.sh          [--no-deploy = product/app/.env only]
# Auth:   Application Default Credentials with access to the Apigee org
#         (gcloud auth application-default login).
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
APIGEE_ORG="${APIGEE_ORG:-$PROJECT_ID}"
APIGEE_ENV="${APIGEE_ENV:-default-dev}"
APIGEE_HOST="${APIGEE_HOST:-YOUR_APIGEE_HOST}"
MODEL="${MODEL:-gemini-2.5-flash-lite}"
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"
ARMOR_LOCATION="${ARMOR_LOCATION:-}"
ARMOR_TEMPLATE="${ARMOR_TEMPLATE:-apigee-model-armor-101}"
RUNTIME_SA="${RUNTIME_SA:-sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com}"

PROXIES=(model-armor-101-native model-armor-101-callout)
PRODUCT="model-armor-101-cli-product"
DEV_EMAIL="model-armor-101-cli@example.com"
APP="model-armor-101-cli"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"
DO_DEPLOY=1; [ "${1:-}" = "--no-deploy" ] && DO_DEPLOY=0

[[ "$ARMOR_LOCATION" =~ ^[a-z0-9-]+$ ]] || { echo "❌ Set ARMOR_LOCATION (the Model Armor template location), e.g. ARMOR_LOCATION=us-central1 ./setup.sh" >&2; exit 1; }
for bin in curl python3 gcloud; do command -v "$bin" >/dev/null || { echo "❌ $bin not found" >&2; exit 1; }; done
[ "$DO_DEPLOY" = 1 ] && { command -v apigeecli >/dev/null || { echo "❌ apigeecli not found (brew install apigeecli)" >&2; exit 1; }; }

TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
api() {  # api METHOD PATH [JSON] -> HTTP code; body in $TMP/body (curl exits 0 on 4xx: branch on the code)
  local args=(-sS -o "$TMP/body" -w '%{http_code}' -X "$1" "${API}$2" -H "Authorization: Bearer ${TOKEN}")
  [ -n "${3:-}" ] && args+=(-H "Content-Type: application/json" --data "$3")
  curl "${args[@]}"
}
fail() { echo "❌ $1 (HTTP $2): $(head -c 400 "$TMP/body")" >&2; exit 1; }

echo "🔧 org=$APIGEE_ORG env=$APIGEE_ENV model=$MODEL"
echo "🛡️  template=projects/$ARMOR_PROJECT/locations/$ARMOR_LOCATION/templates/$ARMOR_TEMPLATE"

# ---------- 1. proxies (staged copy: property set rewritten, repo untouched) ----------
if [ "$DO_DEPLOY" = 1 ]; then
  for P in "${PROXIES[@]}"; do
    mkdir -p "$TMP/$P"; cp -R "$DIR/proxies/$P/apiproxy" "$TMP/$P/apiproxy"
    PROPS="$TMP/$P/apiproxy/resources/properties/demo.properties"
    sed -i.bak -e "s|^vertex_project=.*|vertex_project=${PROJECT_ID}|" -e "s|^model=.*|model=${MODEL}|" \
      -e "s|^armor_project=.*|armor_project=${ARMOR_PROJECT}|" -e "s|^armor_location=.*|armor_location=${ARMOR_LOCATION}|" \
      -e "s|^armor_template=.*|armor_template=${ARMOR_TEMPLATE}|" "$PROPS" && rm -f "$PROPS.bak"
    grep -q "__ARMOR_" "$PROPS" && { echo "❌ unresolved placeholder in $P demo.properties" >&2; exit 1; }
    echo "📦 $P: import"
    apigeecli apis create bundle -n "$P" -f "$TMP/$P/apiproxy" -o "$APIGEE_ORG" -t "$TOKEN" >/dev/null
    echo "🚀 $P: deploy to $APIGEE_ENV as $RUNTIME_SA (waits for READY)"
    apigeecli apis deploy -n "$P" -e "$APIGEE_ENV" -s "$RUNTIME_SA" -o "$APIGEE_ORG" --ovr --wait -t "$TOKEN" >/dev/null
  done
fi

# ---------- 2. product (both proxies) ----------
PRODUCT_JSON=$(PRODUCT="$PRODUCT" APIGEE_ENV="$APIGEE_ENV" python3 -c '
import json, os
print(json.dumps({"name": os.environ["PRODUCT"], "displayName": os.environ["PRODUCT"],
  "description": "Model Armor 101 CLI: native + callout proxies (demo)", "approvalType": "auto",
  "attributes": [{"name": "access", "value": "private"}], "environments": [os.environ["APIGEE_ENV"]],
  "operationGroup": {"operationConfigs": [
    {"apiSource": p, "operations": [{"resource": "/**"}]} for p in ("model-armor-101-native", "model-armor-101-callout")]}}))')
code=$(api GET "/apiproducts/${PRODUCT}")
case "$code" in
  200) code=$(api PUT "/apiproducts/${PRODUCT}" "$PRODUCT_JSON"); [ "$code" = 200 ] || fail "update product" "$code"; echo "✔ product updated" ;;
  404) code=$(api POST "/apiproducts" "$PRODUCT_JSON"); [[ "$code" =~ ^20[01]$ ]] || fail "create product" "$code"; echo "➕ product created" ;;
  *) fail "get product" "$code" ;;
esac

# ---------- 3. developer + app ----------
code=$(api GET "/developers/${DEV_EMAIL}")
case "$code" in
  200) echo "✔ developer exists" ;;
  404) code=$(api POST "/developers" "{\"email\":\"${DEV_EMAIL}\",\"firstName\":\"Model Armor\",\"lastName\":\"CLI\",\"userName\":\"model-armor-101-cli\"}")
       [[ "$code" =~ ^20[01]$ ]] || fail "create developer" "$code"; echo "➕ developer created" ;;
  *) fail "get developer" "$code" ;;
esac
code=$(api GET "/developers/${DEV_EMAIL}/apps/${APP}")
case "$code" in
  200) echo "✔ app exists" ;;
  404) code=$(api POST "/developers/${DEV_EMAIL}/apps" "{\"name\":\"${APP}\",\"apiProducts\":[\"${PRODUCT}\"]}")
       [[ "$code" =~ ^20[01]$ ]] || fail "create app" "$code"; echo "➕ app created" ;;
  *) fail "get app" "$code" ;;
esac
code=$(api GET "/developers/${DEV_EMAIL}/apps/${APP}"); [ "$code" = 200 ] || fail "read app" "$code"
read -r KEY HAS < <(BODY="$TMP/body" PRODUCT="$PRODUCT" python3 -c '
import json, os
c = (json.load(open(os.environ["BODY"])).get("credentials") or [{}])[0]
print(c.get("consumerKey") or "-", "yes" if any(p.get("apiproduct") == os.environ["PRODUCT"] for p in c.get("apiProducts", [])) else "no")')
[ "$KEY" != "-" ] || { echo "❌ app has no credentials" >&2; exit 1; }
if [ "$HAS" != yes ]; then
  code=$(api POST "/developers/${DEV_EMAIL}/apps/${APP}/keys/${KEY}" "{\"apiProducts\":[\"${PRODUCT}\"]}")
  [ "$code" = 200 ] || fail "add product to key" "$code"; echo "➕ product added to key"
fi

# ---------- 4. .env (chmod 600, git-ignored) ----------
ENV_FILE="$DIR/.env"
umask 077
cat > "$ENV_FILE" <<EOF
# Written by setup.sh. Never commit this file.
API_KEY=$KEY
APIGEE_HOST=$APIGEE_HOST
ARMOR_PROJECT=$ARMOR_PROJECT
ARMOR_LOCATION=$ARMOR_LOCATION
ARMOR_TEMPLATE=$ARMOR_TEMPLATE
CONSOLE_HOST=${CONSOLE_HOST:-console.cloud.google.com}
EOF
chmod 600 "$ENV_FILE"
echo ""
echo "✅ Done. App key: ${KEY:0:4}…${KEY: -4} (full key in cli-only/.env)"
unset KEY
echo "   Try: ./ma101.py            (interactive)"
echo "        ./ma101.py -s all     (every scenario, both proxies)"
