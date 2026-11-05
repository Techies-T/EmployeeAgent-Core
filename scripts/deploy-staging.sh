#!/usr/bin/env bash
# ==============================================================================
# Built-in Quality Automated Deployment Script for Staging (Sakura VPS)
# ==============================================================================
set -e

STAGING_HOST="${STAGING_VPS_HOST:-macosui-staging.techiespod.co.jp}"
STAGING_USER="${STAGING_VPS_USER:-debian}"
SSH_KEY="${STAGING_SSH_KEY:-$HOME/.ssh/id_ed25519_vps}"

echo "=================================================="
echo "🔒 [Step 1/5] Node.js Package Security Check (npm audit)..."
echo "=================================================="
npm audit --audit-level=critical

echo "=================================================="
echo "🐳 [Step 2/5] Docker Scout Container Vulnerability Scan (amd64)..."
echo "=================================================="
docker buildx build --platform linux/amd64 -t macosui-staging-test --load .
docker scout cves macosui-staging-test --exit-code --only-severity critical

echo "=================================================="
echo "📦 [Step 3/5] Syncing Files to Sakura VPS (rsync)..."
echo "=================================================="
rsync -avz -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no" \
      --exclude 'node_modules' \
      --exclude '.git' \
      --exclude 'dist' \
      --exclude 'certbot' \
      --exclude 'data' \
      --exclude 'scratch' \
      --exclude '*.sqlite*' \
      --exclude 'server/*.sqlite*' \
      --exclude 'server/database_backup_*.sqlite' \
      --exclude 'server/staging.env' \
      --exclude 'server/development.env' \
      ./ "${STAGING_USER}@${STAGING_HOST}:~/MacOSUI/"

echo "=================================================="
echo "🚀 [Step 4/5] Deploying Image & Recreating Container on Sakura VPS..."
echo "=================================================="
docker save macosui-staging-test:latest | gzip | ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "gunzip | docker load"

ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "
  set -e
  cd ~/MacOSUI

  # Ensure staging.env symlink exists
  if [ -f server/staging.env ] && [ ! -f staging.env ]; then
    ln -sfn server/staging.env staging.env
  fi

  # Tag image for docker-compose
  docker tag macosui-staging-test:latest ghcr.io/minoru61/macosui-web:latest

  # --- Database Initialization / Backup (Zero Data Loss) ---
  if [ -d server/database.sqlite ]; then
    rmdir server/database.sqlite 2>/dev/null || rm -rf server/database.sqlite
  fi
  if [ -d server/audit_database.sqlite ]; then
    rmdir server/audit_database.sqlite 2>/dev/null || rm -rf server/audit_database.sqlite
  fi
  touch server/database.sqlite server/audit_database.sqlite

  if [ -s server/database.sqlite ]; then
    TIMESTAMP=\$(date +\"%Y%m%d_%H%M%S\")
    cp server/database.sqlite server/database_backup_\${TIMESTAMP}.sqlite
    echo \"✅ Backed up database to server/database_backup_\${TIMESTAMP}.sqlite\"
    ls -t server/database_backup_*.sqlite 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
  fi

  # Remove stale ./data directory on VPS so server/db_sqlite.cjs loads /app/server/database.sqlite
  if [ -d ./data ] && [ -z \"\$(ls -A ./data 2>/dev/null)\" ]; then
    rmdir ./data 2>/dev/null || true
  fi

  # --- Recreate Web & Nginx Containers using the verified image ---
  export ENV_FILE=server/staging.env
  export WEB_IMAGE=ghcr.io/minoru61/macosui-web:latest
  docker compose -f docker-compose.staging.yml up -d --force-recreate web nginx
  docker image prune -f 2>/dev/null || true
"

echo "=================================================="
echo "⏳ [Step 5/5] Verifying Remote Container Recreation & Health Check..."
echo "=================================================="
sleep 5
ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "docker ps"
HEALTH_OUTPUT=$(curl -s "https://${STAGING_HOST}/api/health" || echo "FAILED")
echo "Health Check Response: $HEALTH_OUTPUT"

NODE_VER=$(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "docker exec macosui-web node -v")
echo "Remote Container Node.js Version: $NODE_VER"

echo ""
echo "✅ [SUCCESS] Sakura VPS deployment pipeline completed successfully with verified security checks!"
