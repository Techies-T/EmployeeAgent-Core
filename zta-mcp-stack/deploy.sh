#!/usr/bin/env bash
# ==============================================================================
# ZTA-MCP-Gateway: Universal Deployment Entrypoint
# デプロイ方式を選択して実行できます。
#
# 使用例:
#   ./deploy.sh          (対話型メニューで選択)
#   ./deploy.sh --core   (Gateway単体デプロイ)
#   ./deploy.sh --sample (サンプルデータ付きフルスタックデプロイ)
#   ./deploy.sh --status (現在のコンテナ稼働状況を確認)
#   ./deploy.sh --down   (コンテナを停止)
# ==============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

print_header() {
    echo "=========================================================="
    echo "🛡️ ZTA-MCP-Gateway Deployment Manager"
    echo "   Zero Trust Architecture Secure MCP Proxy"
    echo "=========================================================="
}

show_status() {
    echo "🔍 Current Container Status:"
    docker ps --filter "name=zta-mcp-gateway" \
              --filter "name=test_mariadb" \
              --filter "name=mariadb-mcp" \
              --filter "name=admin-procedures-mcp" \
              --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
}

stop_all() {
    echo "🛑 Stopping all ZTA and sample containers..."
    COMPOSE_CMD="docker compose"
    if ! docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
    fi
    $COMPOSE_CMD -f docker-compose.sample.yml down 2>/dev/null || true
    $COMPOSE_CMD -f docker-compose.core.yml down 2>/dev/null || true
    echo "✅ Containers stopped."
}

# 引数処理
case "$1" in
    --core|-c)
        print_header
        bash scripts/deploy-core.sh
        exit 0
        ;;
    --sample|-s|--full|-f)
        print_header
        bash scripts/deploy-sample.sh
        exit 0
        ;;
    --status)
        print_header
        show_status
        exit 0
        ;;
    --down|-d)
        print_header
        stop_all
        exit 0
        ;;
    --help|-h)
        print_header
        echo "Usage: ./deploy.sh [OPTIONS]"
        echo "Options:"
        echo "  --core,   -c  Deploy Gateway ONLY (Core standalone mode)"
        echo "  --sample, -s  Deploy Gateway + NPB MariaDB + Digital Agency MCP (Full sample mode)"
        echo "  --status      Show running status of containers"
        echo "  --down,   -d  Stop all running containers"
        echo "  --help,   -h  Show this help message"
        exit 0
        ;;
esac

# 引数がない場合は対話型メニュー
print_header
echo "デプロイする構成を選択してください:"
echo ""
echo "  [1] Core Only (Gateway単体)"
echo "      - サンプルDBやツールを含まず、ZTA Gatewayのみを起動します。"
echo "      - 顧客既存の社内MCPサーバーや外部APIを保護したい場合に最適です。"
echo ""
echo "  [2] Full Sample (サンプルデータ付きフルスタック)"
echo "      - Gateway + NPB公式データ(MariaDB) + デジタル庁行政手続きMCP を起動します。"
echo "      - 認可・監査ログ・SQLファイアウォールの動作デモや検証に最適です。"
echo ""
echo "  [3] コンテナ稼働状況を確認 (Status)"
echo "  [4] コンテナを停止 (Stop)"
echo "  [q] 終了 (Quit)"
echo ""
read -p "選択してください [1/2/3/4/q]: " CHOICE

case "$CHOICE" in
    1)
        bash scripts/deploy-core.sh
        ;;
    2)
        bash scripts/deploy-sample.sh
        ;;
    3)
        show_status
        ;;
    4)
        stop_all
        ;;
    *)
        echo "終了します。"
        exit 0
        ;;
esac
