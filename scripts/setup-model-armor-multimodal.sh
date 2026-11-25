#!/usr/bin/env bash
# ==============================================================================
# Model Armor prerequisites for the MULTIMODAL proxy (text, images, rich documents).
# Idempotent: each resource is created only if missing; existing resources are never edited.
#
#   1. enable modelarmor + dlp APIs, make sure the Model Armor service agent exists
#   2. Sensitive Data Protection templates in $MM_LOCATION (must match the Model Armor location):
#        inspectTemplates/$MM_SDP_INSPECT    text infoTypes + image object infoType (license plate)
#        deidentifyTemplates/$MM_SDP_REDACT  image redaction (black boxes) for standalone images
#   3. Model Armor templates in $MM_LOCATION, modalities TEXT + IMAGE:
#        $MM_TEMPLATE_INSPECT  inspect only  -> prompts, documents (a de-identify template here would
#                              make Model Armor skip every document that has images)
#        $MM_TEMPLATE_REDACT   inspect + de-identify -> standalone response images (redactedImage)
#   4. IAM: Model Armor service agent -> roles/dlp.user + roles/dlp.reader;
#           Apigee runtime SA          -> roles/modelarmor.user
#
# Why "us": image screening is only available in some locations (us, eu, global; NOT us-central1
# or asia-southeast1). See https://docs.cloud.google.com/model-armor/feature-availability-by-region
#
# Usage:  ./scripts/setup-model-armor-multimodal.sh [--yes]
# Overrides: PROJECT_ID MM_LOCATION MM_TEMPLATE_INSPECT MM_TEMPLATE_REDACT MM_SDP_INSPECT MM_SDP_REDACT RUNTIME_SA
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
MM_LOCATION="${MM_LOCATION:-us}"
MM_TEMPLATE_INSPECT="${MM_TEMPLATE_INSPECT:-apigee-mm-inspect}"
MM_TEMPLATE_REDACT="${MM_TEMPLATE_REDACT:-apigee-mm-redact}"
MM_SDP_INSPECT="${MM_SDP_INSPECT:-apigee-mm-inspect}"
MM_SDP_REDACT="${MM_SDP_REDACT:-apigee-mm-redact}"
RUNTIME_SA="${RUNTIME_SA:-sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com}"
YES=0; [ "${1:-}" = "--yes" ] && YES=1

for v in MM_LOCATION MM_TEMPLATE_INSPECT MM_TEMPLATE_REDACT MM_SDP_INSPECT MM_SDP_REDACT; do
  [[ "${!v}" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "❌ invalid $v" >&2; exit 1; }
done
command -v gcloud >/dev/null || { echo "❌ gcloud not found" >&2; exit 1; }

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
MA_AGENT="service-${PROJECT_NUMBER}@gcp-sa-modelarmor.iam.gserviceaccount.com"
MA_BASE="https://modelarmor.${MM_LOCATION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${MM_LOCATION}"
DLP_BASE="https://dlp.googleapis.com/v2/projects/${PROJECT_ID}/locations/${MM_LOCATION}"
SDP_INSPECT_NAME="projects/${PROJECT_ID}/locations/${MM_LOCATION}/inspectTemplates/${MM_SDP_INSPECT}"
SDP_REDACT_NAME="projects/${PROJECT_ID}/locations/${MM_LOCATION}/deidentifyTemplates/${MM_SDP_REDACT}"

echo "Plan (project $PROJECT_ID, location $MM_LOCATION):"
echo "  SDP inspect template      : $SDP_INSPECT_NAME"
echo "  SDP de-identify template  : $SDP_REDACT_NAME"
echo "  Model Armor templates     : $MM_TEMPLATE_INSPECT (inspect), $MM_TEMPLATE_REDACT (redact)"
echo "  IAM                       : $MA_AGENT -> dlp.user, dlp.reader; $RUNTIME_SA -> modelarmor.user"
if [ "$YES" != 1 ]; then
  read -r -p "Proceed? [y/N] " ans; [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "Aborted."; exit 1; }
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TOKEN="$(gcloud auth print-access-token)"
call() {  # call METHOD URL [JSON] -> prints HTTP code; body in $TMP/body
  local args=(-sS -o "$TMP/body" -w '%{http_code}' -X "$1" "$2" -H "Authorization: Bearer ${TOKEN}"
              -H "x-goog-user-project: ${PROJECT_ID}")
  [ -n "${3:-}" ] && args+=(-H "Content-Type: application/json" --data "$3")
  curl "${args[@]}"
}
ensure() {  # ensure LABEL GET_URL CREATE_URL JSON
  local code; code=$(call GET "$2")
  case "$code" in
    200) echo "✔ $1 exists (left unchanged)" ;;
    404) code=$(call POST "$3" "$4")
         [ "$code" = 200 ] || { echo "❌ create $1 (HTTP $code): $(head -c 500 "$TMP/body")" >&2; exit 1; }
         echo "➕ $1 created" ;;
    *)   echo "❌ get $1 (HTTP $code): $(head -c 500 "$TMP/body")" >&2; exit 1 ;;
  esac
}

echo "🔌 APIs + Model Armor service agent"
gcloud services enable modelarmor.googleapis.com dlp.googleapis.com --project="$PROJECT_ID" >/dev/null
gcloud beta services identity create --service=modelarmor.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

# ---- 2. Sensitive Data Protection templates ----------------------------------
INSPECT_JSON="{\"templateId\":\"${MM_SDP_INSPECT}\",\"inspectTemplate\":{
  \"displayName\":\"Apigee multimodal demo: inspect\",
  \"description\":\"Text infoTypes (OCR and documents) plus image object infoType. Used by Model Armor.\",
  \"inspectConfig\":{\"minLikelihood\":\"POSSIBLE\",\"infoTypes\":[
    {\"name\":\"CREDIT_CARD_NUMBER\"},{\"name\":\"EMAIL_ADDRESS\"},{\"name\":\"PHONE_NUMBER\"},
    {\"name\":\"US_SOCIAL_SECURITY_NUMBER\"},{\"name\":\"IBAN_CODE\"},{\"name\":\"OBJECT_TYPE/LICENSE_PLATE\"}]}}}"
REDACT_JSON="{\"templateId\":\"${MM_SDP_REDACT}\",\"deidentifyTemplate\":{
  \"displayName\":\"Apigee multimodal demo: redact images\",
  \"description\":\"Black boxes over every finding in a standalone image. Used by Model Armor for response images.\",
  \"deidentifyConfig\":{\"imageTransformations\":{\"transforms\":[
    {\"allInfoTypes\":{},\"redactionColor\":{\"red\":0,\"green\":0,\"blue\":0}}]}}}}"
ensure "SDP inspect template"     "$DLP_BASE/inspectTemplates/$MM_SDP_INSPECT"    "$DLP_BASE/inspectTemplates"    "$INSPECT_JSON"
ensure "SDP de-identify template" "$DLP_BASE/deidentifyTemplates/$MM_SDP_REDACT"  "$DLP_BASE/deidentifyTemplates" "$REDACT_JSON"

# ---- 4a. IAM before the Model Armor templates (the service agent must read the SDP templates) ----
for role in roles/dlp.user roles/dlp.reader; do
  echo "🔑 $role -> Model Armor service agent"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${MA_AGENT}" \
    --role="$role" --condition=None --quiet >/dev/null
done
echo "🔑 roles/modelarmor.user -> $RUNTIME_SA"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/modelarmor.user --condition=None --quiet >/dev/null

# ---- 3. Model Armor templates -------------------------------------------------
FILTERS='"raiSettings":{"raiFilters":[
    {"filterType":"HATE_SPEECH","confidenceLevel":"MEDIUM_AND_ABOVE"},
    {"filterType":"HARASSMENT","confidenceLevel":"MEDIUM_AND_ABOVE"},
    {"filterType":"SEXUALLY_EXPLICIT","confidenceLevel":"MEDIUM_AND_ABOVE"},
    {"filterType":"DANGEROUS","confidenceLevel":"MEDIUM_AND_ABOVE"}]},
  "piAndJailbreakFilterSettings":{"filterEnforcement":"ENABLED","confidenceLevel":"MEDIUM_AND_ABOVE"},
  "maliciousUriFilterSettings":{"filterEnforcement":"ENABLED"}'
META='"templateMetadata":{"logTemplateOperations":false,"logSanitizeOperations":false,
  "modalities":["MODALITY_TEXT","MODALITY_IMAGE"]}'
T_INSPECT="{\"filterConfig\":{${FILTERS},\"sdpSettings\":{\"advancedConfig\":{\"inspectTemplate\":\"${SDP_INSPECT_NAME}\"}}},${META}}"
T_REDACT="{\"filterConfig\":{${FILTERS},\"sdpSettings\":{\"advancedConfig\":{\"inspectTemplate\":\"${SDP_INSPECT_NAME}\",\"deidentifyTemplate\":\"${SDP_REDACT_NAME}\"}}},${META}}"
ensure "Model Armor template $MM_TEMPLATE_INSPECT" "$MA_BASE/templates/$MM_TEMPLATE_INSPECT" \
  "$MA_BASE/templates?templateId=${MM_TEMPLATE_INSPECT}" "$T_INSPECT"
ensure "Model Armor template $MM_TEMPLATE_REDACT" "$MA_BASE/templates/$MM_TEMPLATE_REDACT" \
  "$MA_BASE/templates?templateId=${MM_TEMPLATE_REDACT}" "$T_REDACT"

for t in "$MM_TEMPLATE_INSPECT" "$MM_TEMPLATE_REDACT"; do
  code=$(call GET "$MA_BASE/templates/$t"); [ "$code" = 200 ] || { echo "❌ readback $t (HTTP $code)" >&2; exit 1; }
  python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); m=t.get("templateMetadata",{}); s=t["filterConfig"].get("sdpSettings",{}); print(" ", t["name"].split("/")[-1], "| modalities:", m.get("modalities"), "| sdp:", "advanced+deidentify" if s.get("advancedConfig",{}).get("deidentifyTemplate") else "advanced inspect")' "$TMP/body"
done
echo "✅ Multimodal Model Armor resources ready in ${MM_LOCATION}"
