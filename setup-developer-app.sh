#!/usr/bin/env bash
# ==============================================================================
# setup-developer-app.sh - Provision API Product & Developer App for Model Armor
# ==============================================================================
# Automates the creation and configuration of the Apigee API Product and
# Developer App required by the VerifyAPIKey policy in guardrail-proxy.
#
# Usage:
#   ./setup-developer-app.sh [PROJECT_ID] [ENV_NAME] [DEVELOPER_EMAIL]
# ==============================================================================

set -eo pipefail

PROJECT_ID="${1:-YOUR_GCP_PROJECT_ID}"
ENV_NAME="${2:-default-dev}"
DEVELOPER_EMAIL="${3:-YOUR_DEVELOPER_EMAIL}"
PRODUCT_NAME="modelarmor-streaming-product"
APP_NAME="modelarmor-streaming-demo-app"

# Styling colors
COLOR_RESET="\033[0m"
COLOR_BOLD="\033[1m"
COLOR_GREEN="\033[32m"
COLOR_BLUE="\033[34m"
COLOR_CYAN="\033[36m"
COLOR_YELLOW="\033[33m"
COLOR_MAGENTA="\033[35m"

echo -e "${COLOR_CYAN}${COLOR_BOLD}================================================================${COLOR_RESET}"
echo -e "${COLOR_CYAN}${COLOR_BOLD}  🛡️  Apigee Model Armor Developer App & Product Provisioning     ${COLOR_RESET}"
echo -e "${COLOR_CYAN}${COLOR_BOLD}================================================================${COLOR_RESET}"
echo -e "  Organization / Project: ${COLOR_BOLD}$PROJECT_ID${COLOR_RESET}"
echo -e "  Environment:            ${COLOR_BOLD}$ENV_NAME${COLOR_RESET}"
echo -e "  Developer Email:        ${COLOR_BOLD}$DEVELOPER_EMAIL${COLOR_RESET}"
echo -e "  API Product Name:       ${COLOR_BOLD}$PRODUCT_NAME${COLOR_RESET}"
echo -e "  Developer App Name:     ${COLOR_BOLD}$APP_NAME${COLOR_RESET}"
echo ""

# Verify apigeecli is available
if ! command -v apigeecli &> /dev/null; then
  echo -e "${COLOR_YELLOW}Warning: apigeecli is not in PATH. Checking /opt/homebrew/bin/apigeecli...${COLOR_RESET}"
  if [ -f "/opt/homebrew/bin/apigeecli" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  else
    echo "Error: apigeecli not found. Please install apigeecli from https://github.com/apigee/apigeecli"
    exit 1
  fi
fi

# 1. Create or Verify API Product
echo -e "${COLOR_BLUE}▶ Step 1: Checking API Product: ${PRODUCT_NAME}...${COLOR_RESET}"
if apigeecli products get -n "$PRODUCT_NAME" -o "$PROJECT_ID" --default-token &>/dev/null; then
  echo -e "  ${COLOR_GREEN}✔ API Product '$PRODUCT_NAME' already exists.${COLOR_RESET}"
else
  echo -e "  Creating API Product '$PRODUCT_NAME'..."
  apigeecli products create \
    -n "$PRODUCT_NAME" \
    -m "Model Armor Streaming SSE Product" \
    -d "API Product for Model Armor Real-Time SSE Streaming with Gemini 3.5 Flash Lite" \
    -e "$ENV_NAME" \
    -p "guardrail-proxy" \
    -f "auto" \
    --attrs access=public \
    -o "$PROJECT_ID" \
    --default-token
  echo -e "  ${COLOR_GREEN}✔ Created API Product '$PRODUCT_NAME'.${COLOR_RESET}"
fi

# 2. Check Developer
echo -e "${COLOR_BLUE}▶ Step 2: Checking Developer: ${DEVELOPER_EMAIL}...${COLOR_RESET}"
if apigeecli developers get -n "$DEVELOPER_EMAIL" -o "$PROJECT_ID" --default-token &>/dev/null; then
  echo -e "  ${COLOR_GREEN}✔ Developer '$DEVELOPER_EMAIL' verified.${COLOR_RESET}"
else
  echo -e "  Creating Developer '$DEVELOPER_EMAIL'..."
  apigeecli developers create \
    -n "$DEVELOPER_EMAIL" \
    -f "Wely" \
    -l "Lau" \
    -u "welylau" \
    -o "$PROJECT_ID" \
    --default-token
  echo -e "  ${COLOR_GREEN}✔ Created Developer '$DEVELOPER_EMAIL'.${COLOR_RESET}"
fi

# 3. Create or Verify Developer App
echo -e "${COLOR_BLUE}▶ Step 3: Checking Developer App: ${APP_NAME}...${COLOR_RESET}"
APP_JSON=$(apigeecli apps get -n "$APP_NAME" -d "$DEVELOPER_EMAIL" -o "$PROJECT_ID" --default-token 2>/dev/null || true)

if [ -z "$APP_JSON" ] || echo "$APP_JSON" | grep -q "Error"; then
  echo -e "  Creating Developer App '$APP_NAME'..."
  APP_JSON=$(apigeecli apps create \
    -n "$APP_NAME" \
    -e "$DEVELOPER_EMAIL" \
    -p "$PRODUCT_NAME" \
    -o "$PROJECT_ID" \
    --default-token)
  echo -e "  ${COLOR_GREEN}✔ Created Developer App '$APP_NAME'.${COLOR_RESET}"
else
  echo -e "  ${COLOR_GREEN}✔ Developer App '$APP_NAME' already exists.${COLOR_RESET}"
fi

# 4. Extract API Key (Consumer Key)
API_KEY=$(echo "$APP_JSON" | grep -A 10 "consumerKey" | grep -o 'consumerKey": "[^"]*' | head -n1 | cut -d'"' -f3 || true)
if [ -z "$API_KEY" ]; then
  # Fallback parse
  API_KEY=$(echo "$APP_JSON" | grep '"consumerKey"' | head -n1 | sed -E 's/.*"consumerKey": "([^"]+)".*/\1/' || true)
fi

echo ""
echo -e "${COLOR_MAGENTA}${COLOR_BOLD}================================================================${COLOR_RESET}"
echo -e "${COLOR_MAGENTA}${COLOR_BOLD}  🔑 Active Credentials for Demo                                  ${COLOR_RESET}"
echo -e "${COLOR_MAGENTA}${COLOR_BOLD}================================================================${COLOR_RESET}"
echo -e "  Developer:    ${COLOR_BOLD}$DEVELOPER_EMAIL${COLOR_RESET}"
echo -e "  App Name:     ${COLOR_BOLD}$APP_NAME${COLOR_RESET}"
echo -e "  API Product:  ${COLOR_BOLD}$PRODUCT_NAME${COLOR_RESET}"
echo -e "  Consumer Key: ${COLOR_GREEN}${COLOR_BOLD}$API_KEY${COLOR_RESET}"
echo -e "${COLOR_MAGENTA}${COLOR_BOLD}================================================================${COLOR_RESET}"
echo ""
echo -e "To run the demo UI with this API key, run:"
echo -e "  ${COLOR_CYAN}export APIGEE_API_KEY=\"$API_KEY\"${COLOR_RESET}"
echo -e "  ${COLOR_CYAN}cd demo-ui && PORT=8085 python3 app.py${COLOR_RESET}"
echo ""
