#!/usr/bin/env bash
# ==============================================================================
# Deploys the Model Armor and Apigee Demo web UI to Cloud Run behind IAP, with a custom domain.
# Idempotent: safe to re-run after code changes. Based on the SDP demo script.
#
#   ./deploy-cloudrun.sh                               # house defaults
#   DOMAIN=none IAP_MEMBERS=user:me@example.com ./deploy-cloudrun.sh
#
# The Apigee app key is read from API_KEY (env or .env, written by
# ../scripts/setup-apigee.sh) and stored in Secret Manager ($API_KEY_SECRET).
# If API_KEY is unset, the latest existing secret version is used.
# The key is never printed and never baked into the image.
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
APIGEE_HOST="${APIGEE_HOST:-YOUR_APIGEE_HOST}"
SERVICE="${SERVICE:-apigee-model-armor-101-ui}"
DOMAIN="${DOMAIN:-model-armor.YOUR_DOMAIN}"     # DOMAIN=none to skip mapping + DNS
DNS_ZONE="${DNS_ZONE:-YOUR_DNS_ZONE}"
IAP_MEMBERS="${IAP_MEMBERS:-domain:google.com}"       # comma list: user:a@x.com,group:g@x.com
MODEL="${MODEL:-gemini-2.5-flash-lite}"
# Model Armor template linked from the UI (non-secret; from .env if present)
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"; ARMOR_LOCATION="${ARMOR_LOCATION:-}"; ARMOR_TEMPLATE="${ARMOR_TEMPLATE:-apigee-model-armor-101}"
API_KEY_SECRET="${API_KEY_SECRET:-${SERVICE}-api-key}"
API_KEY="${API_KEY:-}"

APIGEE_HOST="${APIGEE_HOST#https://}"; APIGEE_HOST="${APIGEE_HOST%/}"
[ "$DOMAIN" = "none" ] && DOMAIN=""
INSECURE=0; case "$APIGEE_HOST" in *.nip.io) INSECURE=1 ;; esac
SA_NAME="$(printf '%s' "${SERVICE}" | cut -c1-30 | sed 's/-*$//')"   # SA id: 6-30 chars, no trailing '-'
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Refuse to deploy a sanitized (placeholder) tree: run ./restore.sh first.
ROOT="$(cd "$DIR/.." && pwd)"
if [ -f "$ROOT/.sanitize.state" ] && grep -q sanitized "$ROOT/.sanitize.state"; then
  echo "❌ Repo is sanitized (YOUR_* placeholders). Run ./restore.sh before deploying." >&2; exit 1
fi
[ -d "$DIR/static" ] || { echo "❌ $DIR/static is missing" >&2; exit 1; }

g() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
PROJECT_NUMBER=$(g projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "▶ APIs"
g services enable run.googleapis.com iap.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com logging.googleapis.com >/dev/null

echo "▶ Runtime service account: $SA"
g iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  g iam service-accounts create "$SA_NAME" --display-name="Model Armor and Apigee Demo UI (Cloud Run)"
# Admin log panel reads the proxy's Cloud Logging entries.
g projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" \
  --role=roles/logging.viewer --condition=None >/dev/null

echo "▶ Secret: $API_KEY_SECRET"
g secrets describe "$API_KEY_SECRET" >/dev/null 2>&1 || \
  g secrets create "$API_KEY_SECRET" --replication-policy=automatic >/dev/null
CURRENT=$(g secrets versions access latest --secret="$API_KEY_SECRET" 2>/dev/null || true)
if [ -n "$API_KEY" ] && [ "$CURRENT" != "$API_KEY" ]; then
  printf '%s' "$API_KEY" | g secrets versions add "$API_KEY_SECRET" --data-file=- >/dev/null
  echo "  stored a new secret version"
elif [ -z "$CURRENT" ] && [ -z "$API_KEY" ]; then
  echo "❌ $API_KEY_SECRET has no version and API_KEY is unset: run ../scripts/setup-apigee.sh first" >&2; exit 1
fi
unset CURRENT
g secrets add-iam-policy-binding "$API_KEY_SECRET" --member="serviceAccount:$SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null

echo "▶ Build context (only server.py, pdf_text.py, multimodal.py, static/, Dockerfile: .env never leaves the machine)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp "$DIR/Dockerfile" "$DIR/server.py" "$DIR/pdf_text.py" "$DIR/multimodal.py" "$DIR/.dockerignore" "$BUILD/"
cp -R "$DIR/static" "$BUILD/static"

echo "▶ Cloud Run deploy (source build) with IAP"
# max-instances=1: the demo audit store (audit_logs.json) lives in the instance.
# timeout=300: "Screen any modality" with an image answer usually takes 9-12 s but has taken up to ~100 s.
g run deploy "$SERVICE" --source="$BUILD" --region="$REGION" \
  --service-account="$SA" --no-allow-unauthenticated --iap \
  --set-secrets="API_KEY=${API_KEY_SECRET}:latest" \
  --set-env-vars="PROJECT_ID=${PROJECT_ID},APIGEE_HOST=${APIGEE_HOST},MODEL=${MODEL},APIGEE_INSECURE=${INSECURE},ARMOR_PROJECT=${ARMOR_PROJECT},ARMOR_LOCATION=${ARMOR_LOCATION},ARMOR_TEMPLATE=${ARMOR_TEMPLATE},CONSOLE_HOST=${CONSOLE_HOST:-console.cloud.google.com}" \
  --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi --timeout=300 \
  --labels=app=apigee-model-armor-101,managed-by=deploy-cloudrun

echo "▶ IAP: service agent may invoke the service; IAP_MEMBERS may pass IAP"
g beta services identity create --service=iap.googleapis.com >/dev/null 2>&1 || true
g run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker >/dev/null
IFS=',' read -r -a members <<< "$IAP_MEMBERS"
for m in "${members[@]}"; do
  m="$(printf '%s' "$m" | tr -d '[:space:]')"
  [ -n "$m" ] || continue
  g iap web add-iam-policy-binding --resource-type=cloud-run --service="$SERVICE" --region="$REGION" \
    --member="$m" --role=roles/iap.httpsResourceAccessor --condition=None >/dev/null
  echo "  granted $m"
done

if [ -n "$DOMAIN" ]; then
  echo "▶ Domain mapping + DNS: $DOMAIN"
  g beta run domain-mappings describe --domain="$DOMAIN" --region="$REGION" >/dev/null 2>&1 || \
    g beta run domain-mappings create --service="$SERVICE" --domain="$DOMAIN" --region="$REGION"
  FQDN="${DOMAIN}."
  EXISTING=$(g dns record-sets list --zone="$DNS_ZONE" --name="$FQDN" --type=CNAME --format='value(rrdatas[0])' 2>/dev/null || true)
  if [ -z "$EXISTING" ]; then
    g dns record-sets create "$FQDN" --zone="$DNS_ZONE" --type=CNAME --ttl=300 --rrdatas=ghs.googlehosted.com.
  elif [ "$EXISTING" != "ghs.googlehosted.com." ]; then
    echo "  ⚠️  $FQDN already has CNAME $EXISTING, not changing it"
  fi
fi

URL=$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
echo "✅ $SERVICE deployed: $URL${DOMAIN:+  |  https://$DOMAIN (certificate can take 15-60 min)}"
echo "   Verify: curl -s -o /dev/null -w '%{http_code}\n' $URL/api/config   # expect 302/401/403 (IAP), never 200 (not /healthz: Google's front end answers that path itself)"
