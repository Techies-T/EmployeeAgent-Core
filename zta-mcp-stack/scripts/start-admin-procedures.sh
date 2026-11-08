#!/usr/bin/env bash
# ==============================================================================
# デジタル庁 行政手続分析 MCP サーバー 起動スクリプト (Port: 33070)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_DIR="${ROOT_DIR}/services/administrative-procedures-mcp"

echo "=== デジタル庁 行政手続分析 MCP サーバーを起動します ==="
cd "${SERVICE_DIR}"

# Python 仮想環境の確認・作成
if [ ! -d ".venv" ]; then
    echo "Python 仮想環境 (.venv) を作成中..."
    python3 -m venv .venv
    source .venv/bin/activate
    echo "依存パッケージをインストール中..."
    pip install --upgrade pip
    pip install -r requirements.txt
    pip install -e .
else
    source .venv/bin/activate
fi

export ADMIN_PROCEDURES_HOST="${ADMIN_PROCEDURES_HOST:-127.0.0.1}"
export ADMIN_PROCEDURES_PORT="${ADMIN_PROCEDURES_PORT:-33070}"

echo "Starting HTTP Bridge Server on http://${ADMIN_PROCEDURES_HOST}:${ADMIN_PROCEDURES_PORT}/mcp ..."
python mcp_http_server.py
