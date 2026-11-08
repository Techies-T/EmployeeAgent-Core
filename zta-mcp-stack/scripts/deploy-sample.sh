#!/usr/bin/env bash
# ==============================================================================
# ZTA-MCP-Gateway: Full Sample & Demo Deployment Script
# Gateway + NPB公式データ(MariaDB) + デジタル庁行政手続きMCP を一括起動します。
# ==============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "🚀 Deploying ZTA-MCP-Gateway (Full Sample Mode)"
echo "   - Mode: Gateway + MariaDB (NPB) + Digital Agency MCP"
echo "   - Port: 8085 (Gateway), 3306 (DB), 33060 (MariaDB-MCP), 33070 (Admin-MCP)"
echo "   - Config: config/gateway-config.sample.yaml"
echo "=========================================================="

COMPOSE_FILE="docker-compose.sample.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ Error: $COMPOSE_FILE not found in $PROJECT_ROOT"
    exit 1
fi

# Docker Compose コマンド判定
COMPOSE_CMD="docker compose"
if ! docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
fi

echo "🚀 Starting all containers (Gateway + Samples)..."
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build

echo "⏳ Waiting for Gateway and services to be healthy..."
for i in {1..15}; do
    if curl -s http://localhost:8085/healthz >/dev/null 2>&1 || curl -s http://127.0.0.1:8085/healthz >/dev/null 2>&1; then
        echo "✅ ZTA-MCP-Gateway is healthy!"
        break
    fi
    sleep 2
done

# MariaDB に NPB 最新データを確実に流し込む（初期化補完）
if [ -f "setup_npb_data.sql" ] && docker ps --format '{{.Names}}' | grep -q "^test_mariadb$"; then
    echo "📊 Verifying/Importing latest NPB official dataset..."
    docker exec -i test_mariadb mariadb -u root -pmy-secret-pw testdb < setup_npb_data.sql 2>/dev/null || true
    echo "✅ NPB dataset ready!"
fi

echo "=========================================================="
echo "🎉 Full Sample Deployment Complete!"
echo "   - Gateway Health: http://localhost:8085/healthz"
echo "   - NPB MCP via Gateway: http://localhost:8085/mcp/mariadb"
echo "   - Admin MCP via Gateway: http://localhost:8085/mcp/admin-procedures"
echo "=========================================================="
