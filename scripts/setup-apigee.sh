#!/usr/bin/env bash
# ==============================================================================
# Idempotent Apigee setup for apigee-model-armor-101-proxy:
#   1. import the bundle ($PROXY_DIR/apiproxy) as a new revision and deploy it
#      to $APIGEE_ENV with the Apigee runtime SA (-s SA --ovr --wait)
#   2. API product : apigee-model-armor-101-product   (GET -> PUT or POST, HTTP-code checked)
#   3. Developer   : apigee-model-armor-101@example.com
#   4. App         : apigee-model-armor-101-webui     (key associated with the product)
#   5. writes API_KEY to web-ui/.env (chmod 600) and prints the key MASKED
#
# Usage:  ./scripts/setup-apigee.sh            # everything
#         ./scripts/setup-apigee.sh --no-deploy  # consumer resources only
# Overrides: PROJECT_ID APIGEE_ORG APIGEE_ENV MODEL API_KEY_SECRET SERVICE
#            ARMOR_LOCATION (required to deploy) ARMOR_PROJECT ARMOR_TEMPLATE
# Auth: Application Default Credentials (gcloud auth application-default login).
#   The gcloud *user* token is rejected by apigee.googleapis.com with
#   ACCESS_TOKEN_TYPE_UNSUPPORTED in this org (see SDP deploy.sh).
# Layout: <repo>/apigee-model-armor-101-proxy/apiproxy, <repo>/web-ui, <repo>/scripts
#   (override the bundle location with PROXY_DIR=<dir that contains apiproxy/>)
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
APIGEE_ORG="${APIGEE_ORG:-$PROJECT_ID}"
APIGEE_ENV="${APIGEE_ENV:-default-dev}"
MODEL="${MODEL:-gemini-2.5-flash-lite}"
SERVICE="${SERVICE:-apigee-model-armor-101-ui}"
API_KEY_SECRET="${API_KEY_SECRET:-${SERVICE}-api-key}"
# Model Armor template (scripts/setup-model-armor.sh creates it). No default location on purpose.
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"
ARMOR_LOCATION="${ARMOR_LOCATION:-}"
ARMOR_TEMPLATE="${ARMOR_TEMPLATE:-apigee-model-armor-101}"

PROXY="apigee-model-armor-101-proxy"
PRODUCT="apigee-model-armor-101-product"
DEV_EMAIL="apigee-model-armor-101@example.com"
APP="apigee-model-armor-101-webui"
RUNTIME_SA="sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
ROOT="$REPO_ROOT"
PROXY_DIR="${PROXY_DIR:-$REPO_ROOT/apigee-model-armor-101-proxy}"
BUNDLE="$PROXY_DIR/apiproxy"
API="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"
DO_DEPLOY=1; [ "${1:-}" = "--no-deploy" ] && DO_DEPLOY=0

# ---------- preflight ----------
if [ -f "$ROOT/.sanitize.state" ] && grep -q sanitized "$ROOT/.sanitize.state"; then
  echo "❌ Repo is sanitized (YOUR_* placeholders). Run ./restore.sh first." >&2; exit 1
fi
for bin in curl python3 gcloud; do
  command -v "$bin" >/dev/null || { echo "❌ $bin not found" >&2; exit 1; }
done
if [ "$DO_DEPLOY" = 1 ]; then
  command -v apigeecli >/dev/null || { echo "❌ apigeecli not found: brew install apigeecli, or see github.com/apigee/apigeecli" >&2; exit 1; }
  [ -d "$BUNDLE" ] || { echo "❌ bundle not found: $BUNDLE" >&2; exit 1; }
  # Template tokens must be replaced by the scaffold (string split so it is not replaced itself).
  if grep -rq "__DEMO""_SLUG__" "$BUNDLE"; then
    echo "❌ $BUNDLE still contains template tokens" >&2; exit 1
  fi
  if ! [[ "$ARMOR_LOCATION" =~ ^[a-z0-9-]+$ ]]; then
    echo "❌ Set ARMOR_LOCATION to the Model Armor template location (ARMOR_LOCATION=<region> ./scripts/setup-apigee.sh)" >&2; exit 1
  fi
fi
TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "🔧 Apigee org: $APIGEE_ORG / env: $APIGEE_ENV / model: $MODEL"
[ "$DO_DEPLOY" = 1 ] && echo "🛡️  Model Armor template: projects/$ARMOR_PROJECT/locations/$ARMOR_LOCATION/templates/$ARMOR_TEMPLATE"

# ---------- REST helper: api METHOD PATH [JSON]  -> prints HTTP code, body in $TMP/body ----------
# curl exits 0 on HTTP 4xx/5xx, so ALWAYS branch on the code, never on curl's exit status.
api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -o "$TMP/body" -w '%{http_code}' -X "$method" "${API}${path}" -H "Authorization: Bearer ${TOKEN}")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" --data "$data")
  curl "${args[@]}"
}
fail() { echo "❌ $1 (HTTP $2): $(head -c 400 "$TMP/body")" >&2; exit 1; }

# ---------- 1. proxy ----------
if [ "$DO_DEPLOY" = 1 ]; then
  STAGE="$TMP/stage"; mkdir -p "$STAGE"
  cp -R "$BUNDLE" "$STAGE/apiproxy"
  PROPS="$STAGE/apiproxy/resources/properties/demo.properties"
  if [ -f "$PROPS" ]; then
    # Rewrite only the staged copy (COF pattern); the repo stays untouched.
    sed -i.bak -e "s|^vertex_project=.*|vertex_project=${PROJECT_ID}|" -e "s|^model=.*|model=${MODEL}|" \
      -e "s|^armor_project=.*|armor_project=${ARMOR_PROJECT}|" \
      -e "s|^armor_location=.*|armor_location=${ARMOR_LOCATION}|" \
      -e "s|^armor_template=.*|armor_template=${ARMOR_TEMPLATE}|" "$PROPS"
    rm -f "$PROPS.bak"
    if grep -q "__ARMOR_" "$PROPS"; then echo "❌ unresolved armor_* placeholder in demo.properties" >&2; exit 1; fi
  fi
  echo "📦 Importing bundle '$PROXY'"
  apigeecli apis create bundle -n "$PROXY" -f "$STAGE/apiproxy" -o "$APIGEE_ORG" -t "$TOKEN" >/dev/null
  echo "🚀 Deploying '$PROXY' to '$APIGEE_ENV' as $RUNTIME_SA (waits for READY)"
  apigeecli apis deploy -n "$PROXY" -e "$APIGEE_ENV" -s "$RUNTIME_SA" -o "$APIGEE_ORG" --ovr --wait -t "$TOKEN" >/dev/null
  echo "✔ Proxy deployed"
fi

# ---------- 2. API product ----------
# On update, other proxies already on the product (e.g. model-armor-multimodal-proxy,
# added by its own deploy.sh) are kept.
code=$(api GET "/apiproducts/${PRODUCT}")
[ "$code" = 200 ] || [ "$code" = 404 ] || fail "get product" "$code"
EXISTING="$TMP/product-existing.json"
if [ "$code" = 200 ]; then cp "$TMP/body" "$EXISTING"; else echo '{}' > "$EXISTING"; fi
PRODUCT_JSON=$(PRODUCT="$PRODUCT" PROXY="$PROXY" APIGEE_ENV="$APIGEE_ENV" EXISTING="$EXISTING" python3 -c '
import json, os
existing = json.load(open(os.environ["EXISTING"]))
others = [c for c in (existing.get("operationGroup") or {}).get("operationConfigs", [])
          if c.get("apiSource") != os.environ["PROXY"]]
print(json.dumps({
  "name": os.environ["PRODUCT"],
  "displayName": os.environ["PRODUCT"],
  "description": "Access to " + os.environ["PROXY"] + " (demo)",
  "approvalType": "auto",
  "attributes": [{"name": "access", "value": "private"}],
  "environments": [os.environ["APIGEE_ENV"]],
  "operationGroup": {"operationConfigs": [{
    "apiSource": os.environ["PROXY"],
    "operations": [{"resource": "/**"}]}] + others}}))')
case "$code" in
  200) code=$(api PUT "/apiproducts/${PRODUCT}" "$PRODUCT_JSON"); [ "$code" = 200 ] || fail "update product" "$code"; echo "✔ Product '$PRODUCT' updated" ;;
  404) code=$(api POST "/apiproducts" "$PRODUCT_JSON"); [ "$code" = 201 ] || [ "$code" = 200 ] || fail "create product" "$code"; echo "➕ Product '$PRODUCT' created" ;;
esac

# ---------- 3. developer ----------
code=$(api GET "/developers/${DEV_EMAIL}")
case "$code" in
  200) echo "✔ Developer '$DEV_EMAIL' exists" ;;
  404) code=$(api POST "/developers" "{\"email\":\"${DEV_EMAIL}\",\"firstName\":\"Demo\",\"lastName\":\"apigee-model-armor-101\",\"userName\":\"apigee-model-armor-101\"}")
       [ "$code" = 201 ] || [ "$code" = 200 ] || fail "create developer" "$code"; echo "➕ Developer '$DEV_EMAIL' created" ;;
  *) fail "get developer" "$code" ;;
esac

# ---------- 4. app (+ make sure its key carries the product) ----------
code=$(api GET "/developers/${DEV_EMAIL}/apps/${APP}")
case "$code" in
  200) echo "✔ App '$APP' exists" ;;
  404) code=$(api POST "/developers/${DEV_EMAIL}/apps" "{\"name\":\"${APP}\",\"apiProducts\":[\"${PRODUCT}\"]}")
       [ "$code" = 201 ] || [ "$code" = 200 ] || fail "create app" "$code"; echo "➕ App '$APP' created" ;;
  *) fail "get app" "$code" ;;
esac
code=$(api GET "/developers/${DEV_EMAIL}/apps/${APP}"); [ "$code" = 200 ] || fail "read app" "$code"
read -r KEY HAS_PRODUCT < <(BODY_FILE="$TMP/body" PRODUCT="$PRODUCT" python3 -c '
import json, os
c = (json.load(open(os.environ["BODY_FILE"])).get("credentials") or [{}])[0]
has = any(p.get("apiproduct") == os.environ["PRODUCT"] for p in c.get("apiProducts", []))
print(c.get("consumerKey") or "-", "yes" if has else "no")')
[ -n "$KEY" ] && [ "$KEY" != "-" ] || { echo "❌ app has no credentials" >&2; exit 1; }
if [ "$HAS_PRODUCT" != yes ]; then
  code=$(api POST "/developers/${DEV_EMAIL}/apps/${APP}/keys/${KEY}" "{\"apiProducts\":[\"${PRODUCT}\"]}")
  [ "$code" = 200 ] || fail "add product to key" "$code"; echo "➕ Product added to the app key"
fi

# ---------- 5. local .env + masked output ----------
ENV_FILE="$ROOT/web-ui/.env"
if [ -d "$ROOT/web-ui" ]; then
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # Always refresh API_KEY. ARMOR_* are only replaced when ARMOR_LOCATION is known (deploy runs);
  # a --no-deploy run without it keeps the existing ARMOR_* lines instead of dropping them.
  if [ -n "$ARMOR_LOCATION" ]; then STRIP='^(API_KEY|ARMOR_PROJECT|ARMOR_LOCATION|ARMOR_TEMPLATE)='; else STRIP='^API_KEY='; fi
  { grep -vE "$STRIP" "$ENV_FILE" || true; echo "API_KEY=$KEY"
    if [ -n "$ARMOR_LOCATION" ]; then printf 'ARMOR_PROJECT=%s\nARMOR_LOCATION=%s\nARMOR_TEMPLATE=%s\n' "$ARMOR_PROJECT" "$ARMOR_LOCATION" "$ARMOR_TEMPLATE"; fi; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if [ -f "$ROOT/.gitignore" ] && ! grep -qE '^(\*\*/)?\.env$' "$ROOT/.gitignore"; then
    echo "⚠️  .env is not in $ROOT/.gitignore: add it before committing" >&2
  fi
fi
MASKED="${KEY:0:4}…${KEY: -4}"
unset KEY
echo ""
echo "✅ Done. App key ($APP): $MASKED   (full key in web-ui/.env, chmod 600)"
echo "   Store it in Secret Manager for Cloud Run (deploy-cloudrun.sh also does this from .env):"
echo "   ( set -a; . web-ui/.env; printf '%s' \"\$API_KEY\" ) | gcloud secrets versions add ${API_KEY_SECRET} --data-file=- --project=${PROJECT_ID}"
echo "   (create it first if needed: gcloud secrets create ${API_KEY_SECRET} --replication-policy=automatic --project=${PROJECT_ID})"
