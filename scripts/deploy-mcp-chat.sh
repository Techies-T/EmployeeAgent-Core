#!/usr/bin/env bash
# ==============================================================================
# MCP Chat Plugin Standalone VUP Script (without rebuilding EA-Core)
#
# Usage (on EC2 instance):
#   cd /opt/macosui/repo && sudo bash scripts/deploy-mcp-chat.sh
# ==============================================================================
set -e

REPO_DIR="${REPO_DIR:-/opt/macosui/repo}"
DATA_VOLUME="${DATA_VOLUME:-/app/data}"
MCP_CHAT_DIR="${MCP_CHAT_DIR:-$(dirname "$REPO_DIR")/ea-widget-mcp-chat}"
MCP_CHAT_REPO="${MCP_CHAT_REPO:-https://github.com/Techies-T/ea-widget-mcp-chat.git}"

echo "=================================================="
echo "🔌 [1/3] Syncing ea-widget-mcp-chat"
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

if [ -d "$MCP_CHAT_DIR/.git" ]; then
    git -C "$MCP_CHAT_DIR" fetch origin --tags -f
    git -C "$MCP_CHAT_DIR" checkout main
    git -C "$MCP_CHAT_DIR" pull origin main
else
    git clone "$MCP_CHAT_REPO" "$MCP_CHAT_DIR"
fi
echo "Current Commit: $(git -C "$MCP_CHAT_DIR" log -1 --oneline)"

echo "=================================================="
echo "🐳 [2/3] Rebuilding & Restarting ea-widget-mcp-chat ONLY"
echo "=================================================="
COMPOSE_CMD="docker-compose"
if command -v /usr/local/bin/docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="/usr/local/bin/docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
fi

sudo docker rm -f ea-widget-mcp-chat 2>/dev/null || true
sudo $COMPOSE_CMD -f docker-compose.full.yml --profile plugin-service up -d --build --no-deps --force-recreate mcp-chat-plugin
sudo docker image prune -f || true

echo "=================================================="
echo "✅ [3/3] Verify MCP Chat Health"
echo "=================================================="
sleep 3
sudo docker ps --filter "name=ea-widget-mcp-chat"

MCP_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8092/api/health || echo "failed")
if [ "$MCP_HEALTH" = "200" ]; then
    echo "✅ MCP Chat health endpoint responded 200 OK"
else
    echo "❌ MCP Chat health endpoint failed with status: $MCP_HEALTH"
    exit 1
fi
