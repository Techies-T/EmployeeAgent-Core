# Changelog

本プロジェクトのすべての主要な変更履歴は本ファイルに記録されます。
フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

---

## [v1.1.2] - 2026-10-24

### 🚨 Emergency Security Patch Release (Node2Shell & MCP SDK Authorization Fix)

本バージョンは、世界規模で報告された Node.js の重大な脆弱性および MCP SDK の認可バイパス等を修正する緊急セキュリティアップデートです。すべてのユーザーに即時アップデートを強く推奨します。

#### 🔒 Security (脆弱性対応)
- **🟢 Node.js ランタイムの Node 24 Alpine 刷新 (CVE-2026-111497 / Node2Shell 対策)**:
  - Dockerfile のベースイメージを公式 EOL を迎えた `node:20-alpine` から、セキュリティパッチ適用済みの **`node:24-alpine` (`v24.22.1`)** へアップグレード。
  - Brotli 解凍処理における境界外書き込みによるリモートコード実行 (RCE) 脆弱性を完全解消。
- **🛡️ MCP SDK 認可バイパス脆弱性の修正 (CVE-2026-111767 / CVSS 8.6 HIGH)**:
  - `@modelcontextprotocol/sdk` をパッチ版 **`^1.32.2`** へアップデート。
  - 攻撃者が細工したキーにより ZTA の認可チェックをすり抜ける問題を解消し、ゼロトラストの保護境界を回復。
  - あわせて MCP SDK 内のリソース枯渇 DoS (CVE-2026-111768) および他サービス発行トークンの誤受理問題 (CVE-2026-104850) を解消。
- **🚫 IP スプーフィング脆弱性の修正 (GHSA-jqcg-44mw-7w3h / CRITICAL)**:
  - `proxy-addr` をパッチ適用済みバージョンへ更新。
  - IPv4-mapped IPv6 を悪用した送信元 IP の偽装および社内ネットワーク信頼判定のバイパスリスクを完全排除。
- **📦 OS パッケージの最新化**:
  - Alpine 3.24 の最新セキュリティ修正を反映し、`zlib` の脆弱性 (CVE-2026-85091) 等を解消。

#### 🔧 Changed (仕様変更・改善)
- `package.json` のバージョンを `v1.1.2` に更新。
- 全 39 件の単体テスト（SQL Firewall、Context Masking、OAuth 2.1 JWT Verification、Audit Engine）が 100% 正常動作することを確認済み。

#### 📢 利用者向けアップデート手順
既存の稼働環境を利用中の方は、以下のコマンドで最新イメージを再ビルド・再起動してください：
```bash
# 1. 最新コードの取得
git pull origin main

# 2. コンテナの再ビルドと再起動
docker compose down
docker compose up -d --build

# 3. 正常稼働とNode.jsバージョンの確認
curl http://localhost:8085/healthz
docker exec zta-mcp-gateway node -v  # v24.22.1 が表示されれば成功
```

---

## [v1.1.1] - 2026-09-18

### 🚀 AI Analytics Knowledge Base & Pod Integration Release

#### ✨ Added (新機能・機能追加)
- **📚 MacOSUI v2.6.0 AI Analytics ナレッジベース連携対応**:
  - `admin-procedures` および `mariadb` による MCP 分析結果（GenUI ダッシュボード）を、MacOSUI 側の専用 Pod（「デジ庁データ分析」「NPB野球データ分析」）にゼロトークンで永続保存・共有する連携仕様を策定・確認。
- **🔧 パッケージバージョンおよびドキュメント整合性向上**:
  - `package.json` を `v1.1.1` に更新。
  - 最新の MacOSUI 接続ガイドとの連携記述を調整。

---

## [v1.1.0] - 2026-09-17

### 🚀 デジタル庁 行政手続分析 MCP & サンプルデータ統合リリース

#### ✨ Added (新機能・機能追加)
- **🏛️ デジタル庁 行政手続分析 MCP サービス (`services/administrative-procedures-mcp`)**:
  - デジタル庁公式の行政手続棚卸調査データ（令和6年度 75,071件、令和7年度 76,275件）を高速検索・集計する分析エンジンを同梱。
  - `list_datasets`: 調査データセット（`procedures-survey-r7` / `r6`）の一覧取得。
  - `inspect_dataset`: データセットのスキーマ構造、型情報、数値統計の検査。
  - `query_records`: 手続名、根拠法令、所管府省庁、手続類型等の詳細レコード検索・フィルタリング。
  - `summarize_records`: 自治体事務区分別オンライン化率、個人・法人のライフイベント別手続数、添付書類（戸籍・住民票等）撤廃状況のクロス集計。
- **📦 サンプルデータのネイティブ同梱 (`datasets/*/data.parquet`)**:
  - 全数調査データを最適化された Parquet 形式（2ファイル合計 約6.5MB）としてリポジトリに同梱。
  - 外部からのダウンロードや重い変換処理なしに、クローン直後からローカルまたは Docker で即座に DuckDB/Polars 高速クエリが可能。
- **🛡️ ゼロトラスト認可制御 (ZTA PEP / Context Masking)**:
  - `admin-procedures` へのアクセスを ZTA Gateway で保護。
  - `analyst` ロールに対しては 4 つの分析ツールのみを開示し、システム系コマンドや未許可ツールは AI の視界から完全にマスキング（`guest` は完全非開示）。
- **📊 Meta-Catalog MCP への分析モデル & GenUI 設計図登録**:
  - `config/catalog-definitions.yaml` に `digital_agency_procedures` を追加。
  - AI エージェントが国民目線・行政改革視点で高品質なダッシュボードを生成できるよう、推奨レイアウト（`AdministrativeReformDashboard`）および Chart.js グラフ仕様、インサイトバナー仕様を提供。
- **🐳 Docker Compose & ワンコマンド起動環境**:
  - `services/administrative-procedures-mcp/Dockerfile` および `requirements.txt` を作成。
  - `docker-compose.yml` に `admin-procedures-mcp` サービスを追加し、`docker compose up -d` でゲートウェイと分析サーバーを一括起動。
  - ローカル Python 環境用の一発起動スクリプト `scripts/start-admin-procedures.sh` を整備。
- **🧪 統合テストスイートの拡充**:
  - `tests/pep/admin-procedures.test.ts` を追加し、デジ庁ツールの PEP 認可とマスキング挙動を自動検証。

---

## [v0.2.0] - 2026-09-10

### 🚀 Meta-Catalog MCP & SSE Keepalive Engine

#### ✨ Added (新機能・機能追加)
- **📚 Meta-Catalog MCP（DBメタ情報 & GenUI 設計図プロバイダー）**:
  - `list_catalog`: ロール権限に基づき、アクセス可能なデータモデル（テーブル・ビュー・分析ドメイン）の概要一覧を返却。
  - `get_catalog_detail`: 指定したカタログ項目のスキーマ構造（カラム定義、データ型、PK/FKリレーション、NULL許可、インデックス）および推奨 GenUI 仕様（Chart.js スペック、インタラクティブ詳細カード、レイアウト、KPI 指標、AI インサイトバナー）を一元提供。
  - **Context Masking**: PDP（ポリシー決定点）に定義されたロール情報に基づき、権限のないカラムや項目を動的にマスク・除外。
  - **YAML-Driven 構成**: 外部 YAML ファイル（`config/catalog-definitions.yaml`）により、コード変更不要で新しいデータモデルや GenUI テンプレートを即座に追加・拡張可能。
- **🔌 仮想 MCP SSE トランスポートエンドポイント (`/mcp/catalog/sse`)**:
  - アップストリームサーバーを別途立ち上げることなく、ゲートウェイ自身が仮想 MCP サーバーとしてクライアント（MacOSUI 等）と直接 SSE および JSON-RPC 2.0 で通信。
- **🛡️ SQL ファイアウォール許可ステートメントの拡張**:
  - ホワイトリストに `SHOW` および `DESC` ステートメントを追加し、データ探索時の安全な実行をサポート。
- **💓 SSE Keepalive ハートビート機構**:
  - SSE コネクションに対して 15 秒間隔で空行コメント（`: keepalive\n\n`）を送信し、ロードバランサーやリバースプロキシによるアイドルタイムアウト切断を防止。

---

## [v0.1.0] - 2026-09-02

### 🚀 Initial Release of ZTA-MCP-Gateway

#### ✨ Added (新機能・機能追加)
- **🛡️ Zero Trust Architecture (ZTA) リバースプロキシ型 MCP ゲートウェイ**:
  - Model Context Protocol (MCP) 通信を仲介し、最小権限の原則（Least Privilege）を強制。
- **🔐 Agent-to-Agent (A2A) OAuth 2.1 認証 & JWT トークン交換 (`POST /token`)**:
  - クライアントクレデンシャルを用いた暗号化 JWT トークンの発行・検証・サイレントリフレッシュ。
- **⚖️ Dynamic PDP / PEP 認可制御**:
  - トークン内のロールに基づき、利用可能な MCP ツール（`allowed_tools`）を厳格にフィルタリング。
- **🧱 SQL AST ファイアウォール**:
  - データベースクエリを AST 解析し、DROP/TRUNCATE/DELETE などの危険な構文を遮断。
- **📈 監査ログ & レートリミット**:
  - 全 MCP ツール実行の追跡記録、および IP / クライアント単位でのリクエスト流量制御。
