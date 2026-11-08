#!/usr/bin/env bash
# ==============================================================================
# ZTA-MCP-Gateway: Core Standalone Deployment Script
# サンプルデータを含まず、Gateway単体のみを起動します。
# ==============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "🛡️ Deploying ZTA-MCP-Gateway (Core Standalone Mode)"
echo "   - Mode: Gateway ONLY (No sample databases/tools)"
echo "   - Port: 8085 (Proxy to internal 8080)"
echo "   - Config: config/gateway-config.core.yaml"
echo "=========================================================="

COMPOSE_FILE="docker-compose.core.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ Error: $COMPOSE_FILE not found in $PROJECT_ROOT"
    exit 1
fi

# 既存のサンプルコンテナが動いていれば競合を防ぐために停止
if docker ps --format '{{.Names}}' | grep -q "^zta-mcp-gateway$"; then
    echo "ℹ️ Stopping existing zta-mcp-gateway..."
    docker stop zta-mcp-gateway 2>/dev/null || true
    docker rm zta-mcp-gateway 2>/dev/null || true
fi

# Docker Compose コマンド判定
COMPOSE_CMD="docker compose"
if ! docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
fi

echo "🚀 Starting Gateway container..."
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build

echo "⏳ Waiting for Gateway to be healthy..."
for i in {1..10}; do
    if curl -s http://localhost:8085/healthz >/dev/null 2>&1 || curl -s http://127.0.0.1:8085/healthz >/dev/null 2>&1; then
        echo "✅ ZTA-MCP-Gateway is healthy!"
        break
    fi
    sleep 2
done

echo "=========================================================="
echo "🎉 Core Gateway Deployment Complete!"
echo "   - Health Check: http://localhost:8085/healthz"
echo "   - MCP Endpoint: http://localhost:8085/mcp"
echo "=========================================================="
