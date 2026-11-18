#!/usr/bin/env bash
# ==============================================================================
# Virtual Office Plugin Standalone VUP Script (without rebuilding EA-Core)
#
# Usage (on EC2 instance):
#   cd /opt/macosui/repo && sudo bash scripts/deploy-virtual-office.sh
# ==============================================================================
set -e

REPO_DIR="${REPO_DIR:-/opt/macosui/repo}"
DATA_VOLUME="${DATA_VOLUME:-/app/data}"
VIRTUAL_OFFICE_DIR="${VIRTUAL_OFFICE_DIR:-$(dirname "$REPO_DIR")/ea-widget-virtual-office}"
VIRTUAL_OFFICE_REPO="${VIRTUAL_OFFICE_REPO:-https://github.com/Techies-T/ea-widget-virtual-office.git}"

echo "=================================================="
echo "🏢 [1/3] Syncing ea-widget-virtual-office"
echo "=================================================="
cd "$REPO_DIR"

if [ -d "$DATA_VOLUME" ]; then
    if [ ! -f "$REPO_DIR/.env" ] || ! grep -q "DATA_DIR" "$REPO_DIR/.env"; then
        echo "DATA_DIR=$DATA_VOLUME" >> "$REPO_DIR/.env"
    fi
    if [ -f "$DATA_VOLUME/development.env" ]; then
        ln -sfn "$DATA_VOLUME/development.env" "$REPO_DIR/server/development.env"
    fi
fi

if [ -d "$VIRTUAL_OFFICE_DIR/.git" ]; then
    git -C "$VIRTUAL_OFFICE_DIR" fetch origin --tags -f
    git -C "$VIRTUAL_OFFICE_DIR" checkout main
    git -C "$VIRTUAL_OFFICE_DIR" pull origin main
else
    git clone "$VIRTUAL_OFFICE_REPO" "$VIRTUAL_OFFICE_DIR"
fi
echo "Current Commit: $(git -C "$VIRTUAL_OFFICE_DIR" log -1 --oneline)"

echo "=================================================="
echo "🐳 [2/3] Rebuilding & Restarting ea-widget-virtual-office ONLY"
echo "=================================================="
COMPOSE_CMD="docker-compose"
if command -v /usr/local/bin/docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="/usr/local/bin/docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
fi

sudo docker rm -f ea-widget-virtual-office 2>/dev/null || true
sudo $COMPOSE_CMD -f docker-compose.full.yml --profile plugin-service up -d --build --no-deps --force-recreate virtual-office-plugin
sudo docker image prune -f || true

echo "=================================================="
echo "✅ [3/3] Verify Virtual Office Health"
echo "=================================================="
sleep 3
sudo docker ps --filter "name=ea-widget-virtual-office"

VO_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8091/api/health || echo "failed")
if [ "$VO_HEALTH" = "200" ]; then
    echo "✅ Virtual Office health endpoint responded 200 OK"
else
    echo "❌ Virtual Office health endpoint failed with status: $VO_HEALTH"
    exit 1
fi
