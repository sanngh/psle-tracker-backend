#!/usr/bin/env bash
# Reads backend/.env.prod (already filled in with real values) and deploys to Cloud Run.
# Run this from inside the backend/ folder in Cloud Shell: bash deploy-cloud-run.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.prod ]; then
  echo ".env.prod not found next to this script. Fill in your real values first." >&2
  exit 1
fi

set -a
while IFS='=' read -r key value; do
  key="$(echo "$key" | xargs)"
  [ -z "$key" ] && continue
  case "$key" in \#*) continue ;; esac
  export "$key=$value"
done < <(grep -v '^\s*$' .env.prod)
set +a

SERVICE_NAME="${SERVICE_NAME:-psle-tracker-backend}"
REGION="${REGION:-asia-southeast1}"

echo "==> Ensuring required APIs are enabled"
gcloud services enable secretmanager.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format="value(projectNumber)")
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Granting the default Compute Engine service account permission to build from source"
# Newer GCP projects don't grant this by default; without it, 'gcloud run deploy --source'
# fails with PERMISSION_DENIED fetching the uploaded source from Cloud Storage.
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None >/dev/null

echo "==> Pushing secrets to Secret Manager"
push_secret() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "  Skipping ${name} (no value set in .env.prod)"
    return
  fi
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy="automatic" >/dev/null
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  echo "  Updated ${name}"
}
push_secret turso-auth-token "${TURSO_AUTH_TOKEN:-}"
push_secret r2-access-key-id "${R2_ACCESS_KEY_ID:-}"
push_secret r2-secret-access-key "${R2_SECRET_ACCESS_KEY:-}"
push_secret admin-token "${ADMIN_TOKEN:-}"

echo "==> Granting Cloud Run runtime access to secrets"
for name in turso-auth-token r2-access-key-id r2-secret-access-key admin-token; do
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
done

# CONFIDENCE_LEVELS is deliberately omitted: its .env.prod value matches the app's
# built-in default, and its commas would otherwise break --set-env-vars parsing.
ENV_VARS="ENV=${ENV:-prod}##NODE_ENV=${NODE_ENV:-production}##DATABASE_PROVIDER=${DATABASE_PROVIDER:-turso}##USE_SQLITE=${USE_SQLITE:-false}##MEDIA_STORAGE_PROVIDER=${MEDIA_STORAGE_PROVIDER:-r2}##TRUST_PROXY=${TRUST_PROXY:-true}##REQUIRE_EVIDENCE_LINKING=${REQUIRE_EVIDENCE_LINKING:-true}##RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS:-60000}##RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS:-120}##MAX_JSON_PAYLOAD_BYTES=${MAX_JSON_PAYLOAD_BYTES:-1mb}##MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES:-100mb}##CORS_ORIGINS=${CORS_ORIGINS:-}##TURSO_DATABASE_URL=${TURSO_DATABASE_URL:-}##R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-}##R2_BUCKET=${R2_BUCKET:-}##R2_ENDPOINT=${R2_ENDPOINT:-}##R2_PUBLIC_BASE_URL=${R2_PUBLIC_BASE_URL:-}"

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (${REGION})"
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars="^##^${ENV_VARS}" \
  --set-secrets "TURSO_AUTH_TOKEN=turso-auth-token:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest,ADMIN_TOKEN=admin-token:latest"

echo "==> Done. Copy the printed Service URL into frontend/.env.production as EXPO_PUBLIC_API_URL."
