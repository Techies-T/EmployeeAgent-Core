#!/usr/bin/env bash
# ==============================================================================
# EmployeeAgent-Core (EA-Core 1.0.0) - Local Full-Stack Quickstart Script
# EA-Core 本体 + ZTA-MCP-Gateway + MariaDB (NPB 2024-2026) + デジタル庁 MCP を一括起動
# ==============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="full"
if [ "$1" = "--core-only" ]; then
    MODE="core"
fi

echo "=========================================================="
echo "🚀 EmployeeAgent-Core (EA-Core 1.0.0) Local Quickstart"
echo "   Mode: $( [ "$MODE" = "full" ] && echo "Full Stack (EA-Core + ZTA-MCP-Gateway + MariaDB NPB + Digital Agency MCP)" || echo "Core Only (EA-Core standalone)" )"
echo "=========================================================="

# 1. server/development.env の自動生成（未作成の場合のみ乱数キーを生成）
mkdir -p data
if [ ! -f "server/development.env" ]; then
    echo "🔑 Generating fresh server/development.env with random encryption keys..."
    ENC_KEY=$(openssl rand -hex 32)
    JWT_SEC=$(openssl rand -hex 32)
    cat > server/development.env <<EOF
PORT=8080
DB_TYPE=sqlite
DB_ENCRYPTION_KEY=${ENC_KEY}
JWT_SECRET=${JWT_SEC}
SESSION_LOCK_MAX_COUNT=6
EOF
    echo "✅ Created server/development.env"
else
    echo "✅ Using existing server/development.env"
fi

# 2. Docker Compose コマンドの判定
COMPOSE_CMD="docker compose"
if ! docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
fi

# 3. コンテナのビルドと起動
if [ "$MODE" = "full" ]; then
    echo "🐳 Building and starting Full Stack containers..."
    $COMPOSE_CMD -f docker-compose.full.yml up -d --build

    echo "⏳ Waiting for MariaDB (test_mariadb) to be ready..."
    for i in {1..20}; do
        if docker exec test_mariadb mariadb -u root -pmy-secret-pw -e "SELECT 1" >/dev/null 2>&1; then
            break
        fi
        sleep 2
    done

    echo "⚾ Importing NPB 2024-2026 sample dataset into MariaDB..."
    docker exec -i test_mariadb mariadb -u root -pmy-secret-pw testdb < scripts/setup_npb_data.sql 2>/dev/null || true
else
    echo "🐳 Building and starting EA-Core standalone container..."
    $COMPOSE_CMD -f docker-compose.yml up -d --build
fi

echo "⏳ Waiting for EmployeeAgent-Core health check..."
for i in {1..15}; do
    if curl -s http://localhost:8080/api/health | grep -q "ok"; then
        break
    fi
    sleep 2
done

echo ""
echo "=========================================================="
echo "🎉 EmployeeAgent-Core (EA-Core 1.0.0) is up and running!"
echo "   🌐 Web UI:           http://localhost:8080"
echo "   🩺 API Health:       http://localhost:8080/api/health"
if [ "$MODE" = "full" ]; then
    echo "   🛡️ ZTA-MCP-Gateway:  http://localhost:8085/healthz"
    echo "   ⚾ MariaDB (NPB DB): localhost:3306 (DB: testdb)"
fi
echo "=========================================================="
echo "👉 ブラウザで http://localhost:8080 を開き、初期 Activation（Google Client ID 登録）を行ってください。"
