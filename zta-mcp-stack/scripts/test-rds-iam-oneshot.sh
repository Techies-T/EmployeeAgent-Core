#!/usr/bin/env bash
# ==============================================================================
# AWS RDS (MariaDB db.t4g.micro) IAM 認証 15分ワンショット検証＆即削除スクリプト
# ==============================================================================
# 目的:
#   一時的な RDS MariaDB (db.t4g.micro, IAM DB認証有効) を作成し、
#   aurora-rds-mcp の `DB_AUTH_MODE=iam` (SigV4 15分トークン + TLS + Read-Only ガード)
#   による実機疎通テストを実施した後、終了時 (成功・失敗・Ctrl+C 問わず) に
#   RDS インスタンスを自動削除します。
#
# 使い方:
#   ./scripts/test-rds-iam-oneshot.sh [--region ap-northeast-1] [--yes]
#
# 前提条件:
#   - AWS CLI v2 がインストールされ、RDS 作成/削除および rds-db:connect 権限があること
#   - Node.js 20+ および services/aurora-rds-mcp の npm install が完了していること
#   - 実行マシンのグローバル IP からテスト用 RDS (Port 3306) へ到達可能であること
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_DIR="${STACK_DIR}/services/aurora-rds-mcp"

AWS_REGION="${AWS_REGION:-ap-northeast-1}"
AUTO_YES="false"
DB_INSTANCE_ID="ea-iam-oneshot-$(date +%Y%m%d%H%M%S)"
MASTER_USER="admin"
MASTER_PASSWORD="EaTmp$(openssl rand -hex 8)!"
IAM_DB_USER="ea_iam_readonly"
DB_NAME="testdb"
CA_BUNDLE_PATH="/tmp/rds-global-bundle-${DB_INSTANCE_ID}.pem"
CREATED_INSTANCE="false"
CREATED_SG_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --yes|-y)
      AUTO_YES="true"
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "[ERROR] 不明なオプション: $1" >&2
      exit 1
      ;;
  esac
done

cleanup() {
  local exit_code=$?
  echo ""
  echo "======================================================================"
  echo "[CLEANUP] 一時リソースのクリーンアップを開始します..."
  echo "======================================================================"

  if [[ "${CREATED_INSTANCE}" == "true" ]]; then
    echo "[CLEANUP] RDS インスタンス '${DB_INSTANCE_ID}' を即座に削除します..."
    aws rds delete-db-instance \
      --region "${AWS_REGION}" \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null 2>&1 || true

    echo "[CLEANUP] RDS 削除完了を待機中..."
    aws rds wait db-instance-deleted \
      --region "${AWS_REGION}" \
      --db-instance-identifier "${DB_INSTANCE_ID}" 2>/dev/null || true
    echo "[CLEANUP] RDS インスタンス '${DB_INSTANCE_ID}' の削除が完了しました。"
  fi

  if [[ -n "${CREATED_SG_ID}" ]]; then
    echo "[CLEANUP] 一時セキュリティグループ '${CREATED_SG_ID}' を削除します..."
    aws ec2 delete-security-group \
      --region "${AWS_REGION}" \
      --group-id "${CREATED_SG_ID}" >/dev/null 2>&1 || true
  fi

  rm -f "${CA_BUNDLE_PATH}"
  echo "[CLEANUP] 完了しました (exit_code=${exit_code})。"
  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

# 前提コマンドチェック
for cmd in aws node curl openssl; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[ERROR] 必須コマンド '${cmd}' が見つかりません。" >&2
    exit 1
  fi
done

if [[ ! -d "${MCP_DIR}/node_modules" ]]; then
  echo "[ERROR] ${MCP_DIR}/node_modules が存在しません。先に npm install を実行してください。" >&2
  exit 1
fi

echo "======================================================================"
echo " AWS RDS MariaDB (db.t4g.micro) IAM 認証 ワンショット検証"
echo "======================================================================"
echo "  リージョン       : ${AWS_REGION}"
echo "  インスタンス ID  : ${DB_INSTANCE_ID}"
echo "  インスタンス種別 : db.t4g.micro (MariaDB / 20GB gp3 / IAM認証有効)"
echo "  想定実行時間     : 約 10〜15 分（終了時に自動削除）"
echo "  概算 AWS 費用    : 約 \$0.01〜\$0.02 未満"
echo "======================================================================"

if [[ "${AUTO_YES}" != "true" ]]; then
  read -r -p "この内容で一時 RDS を作成してテストを実行しますか？ [y/N]: " confirm
  if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
    echo "キャンセルしました。"
    exit 0
  fi
fi

# 1. AWS アカウント・実行元 IP 確認
echo "[1/7] AWS 認証情報とグローバル IP を確認中..."
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
MY_IP="$(curl -fsSL https://checkip.amazonaws.com | tr -d '[:space:]')"
echo "  Caller ARN : ${CALLER_ARN}"
echo "  My IP      : ${MY_IP}/32"

# 2. デフォルト VPC に一時セキュリティグループ作成 (自分の IP からの 3306 のみ許可)
echo "[2/7] 一時セキュリティグループを作成中 (許可元: ${MY_IP}/32 -> TCP 3306)..."
DEFAULT_VPC_ID="$(aws ec2 describe-vpcs --region "${AWS_REGION}" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
if [[ -z "${DEFAULT_VPC_ID}" || "${DEFAULT_VPC_ID}" == "None" ]]; then
  echo "[ERROR] リージョン ${AWS_REGION} にデフォルト VPC が見つかりません。" >&2
  exit 1
fi

CREATED_SG_ID="$(aws ec2 create-security-group \
  --region "${AWS_REGION}" \
  --group-name "${DB_INSTANCE_ID}-sg" \
  --description "Temporary SG for aurora-rds-mcp IAM oneshot test" \
  --vpc-id "${DEFAULT_VPC_ID}" \
  --query GroupId --output text)"

aws ec2 authorize-security-group-ingress \
  --region "${AWS_REGION}" \
  --group-id "${CREATED_SG_ID}" \
  --protocol tcp \
  --port 3306 \
  --cidr "${MY_IP}/32" >/dev/null

# 3. RDS MariaDB db.t4g.micro を IAM DB 認証有効で作成
echo "[3/7] RDS MariaDB (db.t4g.micro) を作成中..."
aws rds create-db-instance \
  --region "${AWS_REGION}" \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --db-instance-class db.t4g.micro \
  --engine mariadb \
  --allocated-storage 20 \
  --storage-type gp3 \
  --master-username "${MASTER_USER}" \
  --master-user-password "${MASTER_PASSWORD}" \
  --db-name "${DB_NAME}" \
  --vpc-security-group-ids "${CREATED_SG_ID}" \
  --publicly-accessible \
  --enable-iam-database-authentication \
  --backup-retention-period 0 \
  --no-multi-az >/dev/null
CREATED_INSTANCE="true"

echo "[4/7] RDS インスタンスが available になるまで待機中 (約 4〜6 分)..."
aws rds wait db-instance-available \
  --region "${AWS_REGION}" \
  --db-instance-identifier "${DB_INSTANCE_ID}"

DB_ENDPOINT="$(aws rds describe-db-instances \
  --region "${AWS_REGION}" \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
DB_RESOURCE_ID="$(aws rds describe-db-instances \
  --region "${AWS_REGION}" \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --query 'DBInstances[0].DbiResourceId' --output text)"

echo "  Endpoint    : ${DB_ENDPOINT}:3306"
echo "  Resource ID : ${DB_RESOURCE_ID}"

# 5. Amazon RDS Global CA バンドルを取得
echo "[5/7] Amazon RDS Global CA 証明書をダウンロード中..."
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "${CA_BUNDLE_PATH}"

# 6. Master ユーザーで IAM DB ユーザー & テストテーブルを作成 (Node mysql2 使用)
echo "[6/7] IAM DB ユーザー (${IAM_DB_USER}) と検証テーブルを作成中..."
NODE_PATH="${MCP_DIR}/node_modules" node -e '
const fs = require("node:fs");
const mysql = require("mysql2/promise");
(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_ENDPOINT,
    port: 3306,
    user: process.env.MASTER_USER,
    password: process.env.MASTER_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync(process.env.CA_BUNDLE_PATH, "utf8"), rejectUnauthorized: true },
  });
  await conn.query("CREATE TABLE IF NOT EXISTS iam_smoke_test (id INT PRIMARY KEY AUTO_INCREMENT, note VARCHAR(128))");
  await conn.query("INSERT INTO iam_smoke_test (note) VALUES (?)", ["aurora-rds-mcp IAM SigV4 OK"]);
  await conn.query("CREATE USER IF NOT EXISTS ?@\"%\" IDENTIFIED WITH AWSAuthenticationPlugin AS \"RDS\"", [process.env.IAM_DB_USER]);
  await conn.query("GRANT SELECT ON `" + process.env.DB_NAME + "`.* TO ?@\"%\"", [process.env.IAM_DB_USER]);
  await conn.query("FLUSH PRIVILEGES");
  await conn.end();
  console.log("  IAM DB ユーザーおよび検証テーブルの作成が完了しました。");
})().catch((err) => { console.error(err); process.exit(1); });
' DB_ENDPOINT="${DB_ENDPOINT}" MASTER_USER="${MASTER_USER}" MASTER_PASSWORD="${MASTER_PASSWORD}" DB_NAME="${DB_NAME}" CA_BUNDLE_PATH="${CA_BUNDLE_PATH}" IAM_DB_USER="${IAM_DB_USER}"

# 7. aurora-rds-mcp (DB_AUTH_MODE=iam) で実機 IAM 認証 + TLS + Read-Only テストを実行
echo "[7/7] aurora-rds-mcp (DB_AUTH_MODE=iam) で実機接続テストを実行中..."
DB_AUTH_MODE=iam \
AURORA_RDS_ENGINE=rds-mariadb \
AURORA_RDS_HOST="${DB_ENDPOINT}" \
AURORA_RDS_PORT=3306 \
AURORA_RDS_USER="${IAM_DB_USER}" \
AURORA_RDS_DATABASE="${DB_NAME}" \
AWS_REGION="${AWS_REGION}" \
DB_SSL_CA_PATH="${CA_BUNDLE_PATH}" \
DB_READ_ONLY=true \
node -e '
const assert = require("node:assert/strict");
const { createAuroraRdsMcpServer } = require(process.env.MCP_DIR + "/src/server.cjs");
(async () => {
  const app = createAuroraRdsMcpServer();
  await app.initialize();

  const statusRes = await app.callTool("check_connection_status", {});
  const status = JSON.parse(statusRes.content[0].text);
  console.log("  [check_connection_status]", JSON.stringify(status, null, 2));
  assert.equal(status.connected, true);
  assert.equal(status.authMode, "iam");
  assert.equal(status.tls.enabled, true);
  assert.equal(status.iamAuth.tokenFormatValid, true);

  const selectRes = await app.callTool("execute_query", { query: "SELECT * FROM iam_smoke_test" });
  console.log("  [execute_query SELECT]", selectRes.content[0].text);
  assert.ok(selectRes.content[0].text.includes("aurora-rds-mcp IAM SigV4 OK"));

  const blockedRes = await app.callTool("execute_query", { query: "DROP TABLE iam_smoke_test" });
  console.log("  [execute_query DROP blocked]", blockedRes.content[0].text);
  assert.equal(blockedRes.isError, true);

  await app.shutdown();
  console.log("  [SUCCESS] AWS RDS MariaDB IAM 認証 + TLS + Read-Only ガードの全検証に成功しました！");
})().catch((err) => { console.error(err); process.exit(1); });
' MCP_DIR="${MCP_DIR}"
