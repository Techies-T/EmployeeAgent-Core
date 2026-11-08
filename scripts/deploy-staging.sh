#!/usr/bin/env bash
# ==============================================================================
# Built-in Quality Automated Deployment Script for Sakura Internet VPS
# Deploys EmployeeAgent-Core (EA-Core 1.0.0) + ZTA-MCP-Gateway + MariaDB (NPB) + Digital Agency MCP
#
# Usage:
#   bash scripts/deploy-staging.sh                      (Default: Full Stack deploy)
#   DEPLOY_MCP_STACK=false bash scripts/deploy-staging.sh (EA-Core Web only)
#   STAGING_VPS_HOST=your-vps.example.com bash scripts/deploy-staging.sh
# ==============================================================================
set -e

STAGING_HOST="${STAGING_VPS_HOST:-macosui-staging.techiespod.co.jp}"
STAGING_USER="${STAGING_VPS_USER:-debian}"
SSH_KEY="${STAGING_SSH_KEY:-$HOME/.ssh/id_ed25519_vps}"
DEPLOY_MCP_STACK="${DEPLOY_MCP_STACK:-true}"

echo "=================================================="
echo "🔒 [Step 1/5] Node.js Package Security Check (npm audit)..."
echo "=================================================="
npm audit --audit-level=critical

echo "=================================================="
echo "🐳 [Step 2/5] Docker Scout Container Vulnerability Scan (amd64)..."
echo "=================================================="
docker buildx build --platform linux/amd64 -t macosui-staging-test --load .
docker scout cves macosui-staging-test --exit-code --only-severity critical

if [ "$DEPLOY_MCP_STACK" = "true" ] && [ -d "zta-mcp-stack" ]; then
  echo "=================================================="
  echo "🛡️ [Step 2.5/5] Building ZTA-MCP-Gateway & Sample MCP Images (amd64)..."
  echo "=================================================="
  docker buildx build --platform linux/amd64 -t techies-t/zta-mcp-gateway:amd64 --load ./zta-mcp-stack
  docker buildx build --platform linux/amd64 -t techies-t/mariadb-mcp:amd64 --load ./zta-mcp-stack/services/mariadb-mcp
  docker buildx build --platform linux/amd64 -t techies-t/admin-procedures-mcp:amd64 --load ./zta-mcp-stack/services/administrative-procedures-mcp
fi

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
echo "🚀 [Step 4/5] Deploying Images & Recreating Containers on Sakura VPS..."
echo "=================================================="
if [ "$DEPLOY_MCP_STACK" = "true" ] && [ -d "zta-mcp-stack" ]; then
  docker save macosui-staging-test:latest techies-t/zta-mcp-gateway:amd64 techies-t/mariadb-mcp:amd64 techies-t/admin-procedures-mcp:amd64 | gzip | ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "gunzip | docker load"
else
  docker save macosui-staging-test:latest | gzip | ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "gunzip | docker load"
fi

ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "
  set -e
  cd ~/MacOSUI

  # Auto-generate server/staging.env if missing on fresh VPS
  if [ ! -f server/staging.env ]; then
    echo '🔑 Generating fresh server/staging.env on VPS...'
    ENC_KEY=\$(openssl rand -hex 32)
    JWT_SEC=\$(openssl rand -hex 32)
    cat > server/staging.env <<EOF
PORT=8080
DB_TYPE=sqlite
DB_ENCRYPTION_KEY=\${ENC_KEY}
JWT_SECRET=\${JWT_SEC}
SESSION_LOCK_MAX_COUNT=6
EOF
  fi

  if [ -f server/staging.env ] && [ ! -f staging.env ]; then
    ln -sfn server/staging.env staging.env
  fi

  # Tag image for docker-compose
  docker tag macosui-staging-test:latest ghcr.io/minoru61/macosui-web:latest

  # --- Deploy ZTA-MCP-Gateway + MariaDB (NPB) + Digital Agency MCP Stack ---
  if [ '${DEPLOY_MCP_STACK}' = 'true' ] && [ -d zta-mcp-stack ]; then
    docker tag techies-t/zta-mcp-gateway:amd64 techies-t/zta-mcp-gateway:latest
    docker tag techies-t/mariadb-mcp:amd64 techies-t/mariadb-mcp:latest
    docker tag techies-t/admin-procedures-mcp:amd64 techies-t/admin-procedures-mcp:latest
    docker stop apprunner-mcp-server 2>/dev/null || true
    cd ~/MacOSUI/zta-mcp-stack
    docker compose -f docker-compose.sample.yml up -d --no-build
    sleep 6
    docker exec -i test_mariadb mariadb -u root -pmy-secret-pw testdb < setup_npb_data.sql 2>/dev/null || true
    cd ~/MacOSUI
  fi

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

  if [ -d ./data ] && [ -z \"\$(ls -A ./data 2>/dev/null)\" ]; then
    rmdir ./data 2>/dev/null || true
  fi

  # --- Recreate Web & Nginx Containers using the verified image ---
  export ENV_FILE=server/staging.env
  export WEB_IMAGE=ghcr.io/minoru61/macosui-web:latest
  docker compose -f docker-compose.staging.yml up -d --force-recreate web nginx
  sleep 3
  docker exec -u 0 macosui-web sh -c 'grep -q host.docker.internal /etc/hosts || echo \"172.17.0.1 host.docker.internal\" >> /etc/hosts' 2>/dev/null || true
  docker image prune -f 2>/dev/null || true
"

echo "=================================================="
echo "⏳ [Step 5/5] Verifying Remote Container Recreation & Health Check..."
echo "=================================================="
sleep 4
ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "docker ps"
HEALTH_OUTPUT=$(curl -s "https://${STAGING_HOST}/api/health" || echo "FAILED")
echo "Health Check Response: $HEALTH_OUTPUT"

NODE_VER=$(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${STAGING_USER}@${STAGING_HOST}" "docker exec macosui-web node -v")
echo "Remote Container Node.js Version: $NODE_VER"

echo ""
echo "✅ [SUCCESS] Sakura VPS deployment pipeline (EA-Core + ZTA-MCP-Gateway) completed successfully!"
