#!/usr/bin/env bash
# Deploys the backend to a prod Cloud Run service using .env.prod.
# Run from inside the backend/ folder: bash deploy-cloud-run-prod.sh
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env.prod"
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found next to this script. Copy your prod env values into it first." >&2
  exit 1
fi

set -a
while IFS='=' read -r key value; do
  key="$(echo "$key" | xargs)"
  [ -z "$key" ] && continue
  case "$key" in \#*) continue ;; esac
  export "$key=$value"
done < <(grep -v '^\s*$' "$ENV_FILE")
set +a

SERVICE_NAME="${SERVICE_NAME:-psle-tracker-backend}"
REGION="${REGION:-asia-southeast1}"
ENV_NAME="prod"
SECRET_PREFIX="${SECRET_PREFIX:-psle-tracker-backend}"

# Shared defaults if .env.prod does not include them.
export ENV="${ENV:-prod}"
export NODE_ENV="${NODE_ENV:-production}"

echo "==> Ensuring required APIs are enabled"
gcloud services enable secretmanager.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format="value(projectNumber)")
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Granting the default Compute Engine service account permission to build from source"
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None >/dev/null

echo "==> Pushing secrets to Secret Manager"
push_secret() {
  local secret_name="$1"
  local secret_value="${2:-}"

  if [ -z "$secret_value" ]; then
    echo "  Skipping ${secret_name} (empty value)"
    return
  fi

  if ! gcloud secrets describe "$secret_name" >/dev/null 2>&1; then
    gcloud secrets create "$secret_name" --replication-policy="automatic" >/dev/null
  fi

  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" --data-file=- >/dev/null
  echo "  Updated ${secret_name}"
}

push_secret "${SECRET_PREFIX}-turso-auth-token" "${TURSO_AUTH_TOKEN:-}"
push_secret "${SECRET_PREFIX}-r2-access-key-id" "${R2_ACCESS_KEY_ID:-}"
push_secret "${SECRET_PREFIX}-r2-secret-access-key" "${R2_SECRET_ACCESS_KEY:-}"
push_secret "${SECRET_PREFIX}-admin-token" "${ADMIN_TOKEN:-}"

echo "==> Granting Cloud Run runtime access to secrets"
for name in \
  "${SECRET_PREFIX}-turso-auth-token" \
  "${SECRET_PREFIX}-r2-access-key-id" \
  "${SECRET_PREFIX}-r2-secret-access-key" \
  "${SECRET_PREFIX}-admin-token"; do
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
done

ENV_VARS="ENV=${ENV:-prod}##NODE_ENV=${NODE_ENV:-production}##DATABASE_PROVIDER=${DATABASE_PROVIDER:-turso}##USE_SQLITE=${USE_SQLITE:-false}##MEDIA_STORAGE_PROVIDER=${MEDIA_STORAGE_PROVIDER:-r2}##TRUST_PROXY=${TRUST_PROXY:-true}##TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS:-1}##REQUIRE_EVIDENCE_LINKING=${REQUIRE_EVIDENCE_LINKING:-true}##RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS:-60000}##RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS:-120}##AUTH_RATE_LIMIT_WINDOW_MS=${AUTH_RATE_LIMIT_WINDOW_MS:-600000}##AUTH_RATE_LIMIT_MAX_REQUESTS=${AUTH_RATE_LIMIT_MAX_REQUESTS:-10}##UPLOAD_RATE_LIMIT_WINDOW_MS=${UPLOAD_RATE_LIMIT_WINDOW_MS:-3600000}##UPLOAD_RATE_LIMIT_MAX_REQUESTS=${UPLOAD_RATE_LIMIT_MAX_REQUESTS:-20}##MAX_UPLOADS_PER_USER_PER_DAY=${MAX_UPLOADS_PER_USER_PER_DAY:-50}##MAX_JSON_PAYLOAD_BYTES=${MAX_JSON_PAYLOAD_BYTES:-1mb}##MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES:-15mb}##CORS_ORIGINS=${CORS_ORIGINS:-}##TURSO_DATABASE_URL=${TURSO_DATABASE_URL:-}##R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-}##R2_BUCKET=${R2_BUCKET:-}##R2_ENDPOINT=${R2_ENDPOINT:-}##R2_PUBLIC_BASE_URL=${R2_PUBLIC_BASE_URL:-}"

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (${REGION})"
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars="^##^${ENV_VARS}" \
  --set-secrets "TURSO_AUTH_TOKEN=${SECRET_PREFIX}-turso-auth-token:latest,R2_ACCESS_KEY_ID=${SECRET_PREFIX}-r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=${SECRET_PREFIX}-r2-secret-access-key:latest,ADMIN_TOKEN=${SECRET_PREFIX}-admin-token:latest"

echo "==> Done. Copy the printed service URL into your frontend prod config as EXPO_PUBLIC_API_URL."
