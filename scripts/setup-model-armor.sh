#!/usr/bin/env bash
# ==============================================================================
# Model Armor prerequisites for apigee-model-armor-101 (run once, operator-approved).
#   1. enable modelarmor.googleapis.com
#   2. create template $ARMOR_TEMPLATE in $ARMOR_LOCATION (skipped if it already exists; never edited)
#        - Responsible AI: hate, harassment, sexually explicit, dangerous  (MEDIUM_AND_ABOVE)
#        - Prompt injection & jailbreak                                    (MEDIUM_AND_ABOVE)
#        - Malicious URLs
#        - Sensitive Data Protection: basic (no DLP template)
#        - logTemplateOperations / logSanitizeOperations = false (no prompts in logs)
#   3. grant the Apigee runtime SA roles/modelarmor.user + roles/modelarmor.viewer
#   4. read the template back
#
# Usage:  ARMOR_LOCATION=<region> ./scripts/setup-model-armor.sh [--yes]
# Overrides: PROJECT_ID ARMOR_PROJECT ARMOR_TEMPLATE RUNTIME_SA
# Check region/filter availability first: https://docs.cloud.google.com/model-armor/feature-availability-by-region
# ==============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-YOUR_PROJECT_ID}"
ARMOR_PROJECT="${ARMOR_PROJECT:-$PROJECT_ID}"
ARMOR_LOCATION="${ARMOR_LOCATION:-}"
ARMOR_TEMPLATE="${ARMOR_TEMPLATE:-apigee-model-armor-101}"
RUNTIME_SA="${RUNTIME_SA:-sa-apigee-aiservices@${PROJECT_ID}.iam.gserviceaccount.com}"
YES=0; [ "${1:-}" = "--yes" ] && YES=1

[[ "$ARMOR_LOCATION" =~ ^[a-z0-9-]+$ ]] || { echo "❌ Set ARMOR_LOCATION (no default on purpose: pick the residency region)" >&2; exit 1; }
[[ "$ARMOR_TEMPLATE" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "❌ invalid ARMOR_TEMPLATE" >&2; exit 1; }
command -v gcloud >/dev/null || { echo "❌ gcloud not found" >&2; exit 1; }

BASE="https://modelarmor.${ARMOR_LOCATION}.rep.googleapis.com/v1/projects/${ARMOR_PROJECT}/locations/${ARMOR_LOCATION}"
NAME="projects/${ARMOR_PROJECT}/locations/${ARMOR_LOCATION}/templates/${ARMOR_TEMPLATE}"
TEMPLATE_JSON='{
  "filterConfig": {
    "raiSettings": {"raiFilters": [
      {"filterType": "HATE_SPEECH",       "confidenceLevel": "MEDIUM_AND_ABOVE"},
      {"filterType": "HARASSMENT",        "confidenceLevel": "MEDIUM_AND_ABOVE"},
      {"filterType": "SEXUALLY_EXPLICIT", "confidenceLevel": "MEDIUM_AND_ABOVE"},
      {"filterType": "DANGEROUS",         "confidenceLevel": "MEDIUM_AND_ABOVE"}
    ]},
    "piAndJailbreakFilterSettings": {"filterEnforcement": "ENABLED", "confidenceLevel": "MEDIUM_AND_ABOVE"},
    "maliciousUriFilterSettings":   {"filterEnforcement": "ENABLED"},
    "sdpSettings": {"basicConfig":  {"filterEnforcement": "ENABLED"}}
  },
  "templateMetadata": {"logTemplateOperations": false, "logSanitizeOperations": false}
}'

echo "Plan:"
echo "  project            : $ARMOR_PROJECT"
echo "  template           : $NAME"
echo "  runtime SA (roles) : $RUNTIME_SA -> roles/modelarmor.user, roles/modelarmor.viewer"
if [ "$YES" != 1 ]; then
  read -r -p "Proceed? [y/N] " ans; [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "Aborted."; exit 1; }
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TOKEN="$(gcloud auth print-access-token)"
call() {  # call METHOD URL [JSON] -> prints HTTP code; body in $TMP/body
  # x-goog-user-project: a gcloud *user* token needs an explicit quota project for this API.
  local args=(-sS -o "$TMP/body" -w '%{http_code}' -X "$1" "$2" -H "Authorization: Bearer ${TOKEN}"
              -H "x-goog-user-project: ${ARMOR_PROJECT}")
  [ -n "${3:-}" ] && args+=(-H "Content-Type: application/json" --data "$3")
  curl "${args[@]}"
}

echo "🔌 Enabling modelarmor.googleapis.com"
gcloud services enable modelarmor.googleapis.com --project="$ARMOR_PROJECT"

code=$(call GET "$BASE/templates/$ARMOR_TEMPLATE")
case "$code" in
  200) echo "✔ Template exists: left unchanged (review its filters below)" ;;
  404) REQ_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
       code=$(call POST "$BASE/templates?templateId=${ARMOR_TEMPLATE}&requestId=${REQ_ID}" "$TEMPLATE_JSON")
       [ "$code" = 200 ] || { echo "❌ create template (HTTP $code): $(head -c 400 "$TMP/body")" >&2; exit 1; }
       echo "➕ Template created" ;;
  *)   echo "❌ get template (HTTP $code): $(head -c 400 "$TMP/body")" >&2; exit 1 ;;
esac

for role in roles/modelarmor.user roles/modelarmor.viewer; do
  echo "🔑 $role -> $RUNTIME_SA"
  gcloud projects add-iam-policy-binding "$ARMOR_PROJECT" --member="serviceAccount:${RUNTIME_SA}" \
    --role="$role" --condition=None --quiet >/dev/null
done

code=$(call GET "$BASE/templates/$ARMOR_TEMPLATE")
[ "$code" = 200 ] || { echo "❌ readback failed (HTTP $code)" >&2; exit 1; }
python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(json.dumps({k:t.get(k) for k in ("name","filterConfig","templateMetadata","updateTime")}, indent=2))' "$TMP/body"
echo ""
echo "✅ Next: ARMOR_LOCATION=${ARMOR_LOCATION} ./scripts/setup-apigee.sh"
