# ZTA MCP Gateway (Zero Trust Architecture MCP Gateway)

[![Version](https://img.shields.io/badge/version-1.1.2-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![MCP](https://img.shields.io/badge/MCP-2026.7_Compliant-green.svg)](https://modelcontextprotocol.io/)
[![Zero Trust](https://img.shields.io/badge/Security-ZTA_Compliant-orange.svg)](#)
[![Changelog](https://img.shields.io/badge/Changelog-v1.1.2-brightgreen.svg)](CHANGELOG.md)

**ZTA MCP Gateway** は、Model Context Protocol (MCP) サーバーのための **ゼロトラスト・リバースプロキシ型セキュリティゲートウェイ** です。  
AIエージェント（LLM）とMCPサーバー（MariaDB公式MCP、Docker Monitor MCP等）の間に配置することで、**「AIの視界マスキング（認可外ツールの非公開）」**、**「SQL/引数ファイアウォール（破壊的クエリの遮断）」**、**「マルチクラウド対応のプラガブル鍵管理」** を提供し、安全なAIエージェント運用を実現します。

---

## 📌 開発の背景と解決する課題

### 1. サードパーティMCPサーバーの認可欠落（Confused Deputy問題）
- **現状の課題**:  
  MariaDB公式MCPサーバーをはじめとする多くのMCPサーバーは、「すべてのツール（テーブル参照・更新・削除）が単一のエンドポイントで公開」されており、ユーザーやAIエージェントのロールに応じたツール単位のきめ細かいアクセス制御ができません。
- **発生するリスク**:  
  「売上データのみを参照させたい」一般ユーザーのプロンプトであっても、AIエージェントは `write_query` や `drop_table` などの危険なツールを認識し、自律的に探索や意図しない更新・削除を実行してしまう恐れ（Confused Deputy問題）があります。

### 2. クラウドベンダーロックインの回避
- AWSのSecrets Manager / KMSのみに依存すると、オンプレミス、さくらのVPS、GCP、Kubernetes環境などを利用する企業で導入障壁となります。
- 本ゲートウェイは **完全コンテナ化されたポータブル設計** とし、暗号鍵やクレデンシャルの保管先を「Local」「GCP」「AWS」「GitHub」「Vault」から柔軟に切り替えられる設計を採用しています。

### 3. アタックサーフェス最小化のための「ヘッドレス」設計
- セキュリティ中継地点であるゲートウェイ自身に管理用Web UIを持たせると、Webアプリケーション脆弱性（XSS, CSRF, セッションハイジャック）のリスクが生じます。
- ゲートウェイ本体は **完全ヘッドレス（Headless Core）** とし、設定はYAMLファイル駆動、または上位システム（MacOSUI等）のコントロールプレーンから安全に配信します。

---

## 🛡️ 主な特徴とセキュリティ機構

```mermaid
flowchart TD
    subgraph AI Client
        Client[MacOSUI / Claude Desktop / Custom Agent]
    end

    subgraph ZTA MCP Gateway [ZTA MCP Gateway (Headless Reverse Proxy)]
        Auth[1. OAuth 2.1 Token Verifier<br/>ロール / スコープ / クライアント識別]
        Masking[2. Context Masking PEP<br/>tools/list から未許可ツールを消去]
        Firewall[3. Query Firewall PEP<br/>tools/call の引数・SQL AST構文解析]
        Audit[4. Audit Logging Engine<br/>構造化JSONで全リクエスト/判定を記録]
        SecretMgr[5. Pluggable Secret Provider<br/>Local / GCP / AWS / GitHub / Vault]
    end

    subgraph Upstream MCP Servers
        MariaDB[MariaDB Official MCP Server]
        Docker[Docker Monitor MCP Server]
        Other[Other External MCP Servers]
    end

    Client -->|OAuth 2.1 Bearer Token| Auth
    Auth --> Masking
    Auth --> Firewall
    Masking -->|Sanitized tools/list| Client
    Firewall -->|Allow / Forward| MariaDB
    Firewall -->|Allow / Forward| Docker
    Firewall -->|Allow / Forward| Other
    Firewall -.->|Block 403 Forbidden| Client
    Firewall -.-> Audit
    SecretMgr -.->|Credentials Injection| Firewall
```

### 1. Context Masking（AI視界マスキング）
AIエージェントが `tools/list` を呼び出した際、トークンに含まれるロール（例: `viewer`, `readonly-analyst`）を評価し、**認可されていないツール（更新系ツール、危険なコマンド）を一覧から完全に削除**して返却します。  
AIはそもそもツールの存在を認識できないため、ハルシネーションや探索的悪用が根本から防止されます。

### 2. Query Firewall（実行時SQL構文解析・PEP）
万が一AIが `tools/call` を推測して直接呼び出した場合でも、SQLパーサーによるAST（抽象構文木）解析を実施。
- `SELECT` 以外の `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE` を検知
- セミコロンによる多重クエリ（`SELECT 1; DROP TABLE users;` 等）を検知
- 不正が検出された場合は上流MCPサーバーにパケットを渡さず、即座に `403 Forbidden` を返却

### 3. プラガブル・シークレット・プロバイダ (`ISecretProvider`)
以下の暗号鍵・シークレット管理プロバイダを環境変数1つで切り替え可能：
- `local`: AES-256-GCM暗号化ファイル / 環境変数（オンプレミス・開発環境向け）
- `gcp`: Google Cloud Secret Manager / Cloud KMS
- `aws`: AWS Secrets Manager / AWS KMS
- `github`: GitHub Secrets API（CI/CD・GitHub Actions統合向け）
- `vault`: HashiCorp Vault / OpenBao（プライベートクラウド・金融系向け）

### 4. 2026年7月 MCP最新仕様への完全準拠
- **Stateless Core**: セッション状態を持たず、水平スケール可能なステートレス設計
- **OAuth 2.1 M2M**: JWTを用いた厳格なマシン間（A2A / Agent-to-Agent）認証
- **SSE Transport**: `GET /sse` および `POST /message` による堅牢なイベント駆動通信

---

## 📁 ディレクトリ構成

```text
zta-mcp-gateway/
├── README.md                           # 本ドキュメント
├── package.json                        # パッケージ設定
├── config/
│   └── gateway-config.example.yaml     # ゲートウェイ設定サンプル (MariaDB, Docker等)
├── docs/
│   ├── SPECIFICATION.md                # 詳細仕様書 (アーキテクチャ・PEP・プロバイダ仕様)
│   └── ARCHITECTURE.md                 # アーキテクチャ図とデータフロー
└── src/                                # 実装ソースコード (Phase 2で開発)
    ├── index.ts                        # サーバーエントリーポイント
    ├── auth/                           # OAuth 2.1 / JWT 検証
    ├── pep/                            # Policy Enforcement Point (Masking & Firewall)
    ├── proxy/                          # リバースプロキシ・SSE通信層
    ├── secrets/                        # プラガブル鍵管理 (Local/GCP/AWS/Vault/GitHub)
    └── audit/                          # 構造化監査ログ出力
```

---

## 🚀 設定ファイル仕様と運用ガイド (`gateway-config.yaml`)

本ゲートウェイは、**「上流のMCPサーバー（MariaDB等）のソースコードを一切改修することなく、設定ファイル（YAML）の定義のみで単一のMCPサーバーを『参照専用』と『管理者用（更新可能）』の2つの独立したツールセットへ動的に分離」** します。

---

### 1. ツール分離（Context Masking）の動作原理

上流の MariaDB MCP サーバーが提供する 5 つのツール（`read_query`, `write_query`, `drop_table`, `list_tables`, `describe_table`）に対し、接続元クライアントの JWT ロールに応じてゲートウェイが動的に視界をフィルタリングします。

```text
┌──────────────────────────────────────────────────────────┐
│  上流 MCP サーバー (mariadb-mcp-server: 1プロセスのみ稼働)│
│  提供ツール: list_tables, describe_table,               │
│             read_query, write_query, drop_table          │
└────────────────────────────┬─────────────────────────────┘
                             │ (リバースプロキシ中継)
┌────────────────────────────▼─────────────────────────────┐
│  ZTA MCP Gateway (PEP: Policy Enforcement Point)         │
│  ※ クライアントの OAuth JWT トークン (roles) を動的評価 │
└──────────────┬────────────────────────────┬──────────────┘
               │                            │
  (roles: ["analyst"])             (roles: ["admin"])
               ▼                            ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ ① 参照専用ツールセット (3個) │ │ ② 管理者用ツールセット (5個)│
│ ・read_query                │ │ ・read_query                │
│ ・list_tables               │ │ ・write_query               │
│ ・describe_table            │ │ ・drop_table                │
│ ※ 更新ツールは完全隠蔽      │ │ ・list_tables               │
│ ※ SQL FirewallでSELECT限定  │ │ ・describe_table            │
└─────────────────────────────┘ └─────────────────────────────┘
```

---

### 2. 完全な設定サンプル (`config/gateway-config.container.yaml`)

```yaml
version: "1.0"

server:
  port: 8080
  host: "0.0.0.0"
  cors:
    origin: "*"

# -------------------------------------------------------------
# ① OAuth 2.1 M2M 認証設定 (Client ID & Client Secret)
# -------------------------------------------------------------
auth:
  issuer: "https://auth.techies.tokyo"
  audience: "zta-mcp-gateway"
  local_jwt_secret_env: "GATEWAY_JWT_SECRET"
  clients:
    # 参照専用クライアント (一般ユーザー・アナリスト用)
    - client_id: "macosui-analyst"
      client_secret: "analyst-secret-2026"
      roles: ["analyst"]

    # 管理者用クライアント (システム管理者用)
    - client_id: "macosui-admin"
      client_secret: "admin-secret-2026"
      roles: ["admin"]

# -------------------------------------------------------------
# ② プラガブル暗号鍵プロバイダ
# -------------------------------------------------------------
secrets:
  provider: "local"  # local | gcp | aws | github | vault

# -------------------------------------------------------------
# ③ 上流MCPサーバーとツール分離ポリシー (Context Masking & Firewall)
# -------------------------------------------------------------
upstreams:
  - id: "mariadb"
    path: "/mcp/mariadb"
    target: "http://host.docker.internal:33060/mcp"   # 単一のMariaDB MCPサーバー
    description: "MariaDB MCP Server with ZTA Protection"
    policies:
      # ロールごとの利用可能ツール定義 (Context Masking)
      role_mappings:
        guest:
          allowed_tools: []
        # analystロール：参照系3ツールのみを公開 (write_query, drop_tableは不可視化)
        analyst:
          allowed_tools:
            - "read_query"
            - "list_tables"
            - "describe_table"
        # adminロール：全ツール利用可能
        admin:
          allowed_tools:
            - "*"

      # 実行時クエリ構文解析ファイアウォール (Query Firewall)
      firewall:
        enforce_sql_check: true
        restricted_roles:
          - "analyst"
        allowed_statements:
          - "SELECT"                                   # analystはSELECT文のみ許可
        deny_statements:                               # 破壊的・更新系SQLは構文解析木(AST)で即時遮断
          - "INSERT"
          - "UPDATE"
          - "DELETE"
          - "DROP"
          - "ALTER"
          - "TRUNCATE"
          - "GRANT"
          - "REVOKE"
```

---

### 3. クライアント側（MacOSUI）での登録手順

MacOSUIの管理画面（`System Settings > MCP Connections`）では、同一エンドポイントに対して2種類のクレデンシャルを登録します。

1. **参照専用の登録**:
   - **名称**: `NPB Baseball (参照専用)`
   - **Endpoint URL**: `http://host.docker.internal:8085/mcp/mariadb/sse`
   - **Token URL**: `http://host.docker.internal:8085/oauth/token`
   - **Client ID**: `macosui-analyst`
   - **Client Secret**: `analyst-secret-2026`
   - **認識ツール数**: **3個** (`read_query`, `list_tables`, `describe_table`)

2. **管理者用（参照・更新）の登録**:
   - **名称**: `NPB Baseball (管理者用 / 参照・更新)`
   - **Endpoint URL**: `http://host.docker.internal:8085/mcp/mariadb/sse`
   - **Token URL**: `http://host.docker.internal:8085/oauth/token`
   - **Client ID**: `macosui-admin`
   - **Client Secret**: `admin-secret-2026`
   - **認識ツール数**: **5個** (`read_query`, `write_query`, `drop_table`, `list_tables`, `describe_table`)

3. **ロールへの適用 (`System Settings > Roles & Permissions`)**:
   - 一般ユーザー（`user` ロール）には `参照専用` のみチェックをONにし、`管理者用` をOFFにします。
   - 管理者（`admin` ロール）には全権限（Full Access）を付与します。

---

### 4. curl による動作検証・疎通コマンド

運用管理者がコマンドラインから直接ゲートウェイの分離・遮断動作を検証するための手順です。

#### (1) OAuth トークン（JWT）の発行
```bash
# 参照専用 (analyst) のトークン取得
ANALYST_TOKEN=$(curl -s -X POST http://localhost:8085/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=macosui-analyst&client_secret=analyst-secret-2026&audience=http://localhost:8085/mcp/mariadb/sse" \
  | jq -r .access_token)

# 管理者 (admin) のトークン取得
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8085/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=macosui-admin&client_secret=admin-secret-2026&audience=http://localhost:8085/mcp/mariadb/sse" \
  | jq -r .access_token)
```

#### (2) ツール一覧（Context Masking）の確認
```bash
# analyst でのリクエスト（3個のみ返却されることを確認）
curl -s -X POST http://localhost:8085/mcp/mariadb \
  -H "Authorization: Bearer $ANALYST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}' \
  | jq '.result.tools[].name'
# 出力: "read_query", "list_tables", "describe_table"

# admin でのリクエスト（全5個が返却されることを確認）
curl -s -X POST http://localhost:8085/mcp/mariadb \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}' \
  | jq '.result.tools[].name'
# 出力: "read_query", "write_query", "drop_table", "list_tables", "describe_table"
```

#### (3) SQL Firewall による不正クエリ遮断の確認
```bash
# analyst トークンで UPDATE 文を含む read_query を強行呼び出し
curl -s -X POST http://localhost:8085/mcp/mariadb \
  -H "Authorization: Bearer $ANALYST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "read_query",
      "arguments": { "query": "UPDATE batting_stats SET home_runs = 50 WHERE player_id = 1;" }
    },
    "id": 2
  }' | jq .
```
**期待されるレスポンス (403 Forbidden)**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32600,
    "message": "Execution denied: Execution denied: Statement type 'UPDATE' is forbidden by ZTA policy."
  }
}
```

---

## 🏛️ デジタル庁 行政手続分析 MCP サービス（実証サンプル同梱）

本リポジトリには、デジタル庁がオープンデータとして公開している**「行政手続等の棚卸調査結果（令和6年度 75,071件、令和7年度 76,275件）」**を高速分析する MCP サーバー（`services/administrative-procedures-mcp`）が実証サンプルデータとともに同梱されています。

### 1. 特徴とアーキテクチャ
- **同梱サンプルデータ**:
  - 全7.6万件の行政手続全数データを最適化済み Parquet 形式（合計 約6.5MB）でリポジトリにネイティブ収録。
  - クローン直後から外部通信なしでローカルまたはコンテナ内で即座に集計・検索可能。
- **ZTA セキュリティ**:
  - `analyst` ロールに対して `list_datasets`, `inspect_dataset`, `query_records`, `summarize_records` の4つの分析ツールのみを公開。
  - 危険なシステムコマンドや未認可ツールは Context Masking により AI の視界から遮断。
- **Meta-Catalog MCP 連携**:
  - AI エージェントに対して「行政改革ダッシュボード（`AdministrativeReformDashboard`）」の推奨レイアウト、Chart.js 設計図を提供。

### 2. ワンコマンド起動方法

#### 方式 A: Docker Compose による一括起動（推奨）
```bash
# ゲートウェイとデジ庁MCPサーバーを一括起動
docker compose up -d

# 稼働ステータス確認
docker compose ps
```

#### 方式 B: ローカル Python での直接起動
```bash
# ポート 33070 で HTTP ブリッジを起動（初回は自動で仮想環境構築と依存インストールを実施）
bash scripts/start-admin-procedures.sh
```

### 3. MacOSUI からの接続
1. MacOSUI の **MCP サーバー管理** 画面を開く。
2. 以下の設定で追加（または `autoActivate` により自動登録）：
   - **名称**: `デジタル庁 行政手続分析 MCP (ZTA保護)`
   - **エンドポイント URL**: `http://host.docker.internal:8085/mcp/admin-procedures/sse`
   - **トークン URL**: `http://host.docker.internal:8085/oauth/token`
   - **Client ID**: `macosui-analyst`
   - **Client Secret**: `analyst-secret-2026`
3. チャットまたはプロンプトテンプレートから「行政手続・ライフイベント別デジタル化ダッシュボード」を選択して実行すると、国民のライフイベント別手続数や添付書類撤廃状況を可視化する GenUI ダッシュボードが自動生成されます。

---

## 📄 詳細仕様書
より詳細なシステム要件、インターフェース定義、セキュリティ監査ログの仕様については、[docs/SPECIFICATION.md](docs/SPECIFICATION.md) をご覧ください。
デジタル庁 MCP の詳細なデータ仕様とクエリ例は [docs/DIGITAL_AGENCY_MCP_GUIDE.md](docs/DIGITAL_AGENCY_MCP_GUIDE.md) をご覧ください。

---

## 📜 ライセンス
Apache License 2.0
