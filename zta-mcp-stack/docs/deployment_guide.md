# ZTA-MCP-Gateway デプロイメントガイド (Core vs Sample)

本ドキュメントは、**ZTA-MCP-Gateway** を顧客環境や検証環境にデプロイする際の運用マニュアルです。
お客様の要件（「Gateway単体のみが必要」か「サンプルデータ付きのデモ・PoCが必要」か）に応じて、2つのデプロイ方式を選択できます。

---

## 1. デプロイ方式の比較

| 項目 | ① Core モード（Gateway単体） | ② Full Sample モード（サンプルデータ付き） |
| :--- | :--- | :--- |
| **対象顧客** | **自前のMCPや社内APIを持つ本番顧客** | **動作デモ・検証・PoCを体験したい顧客** |
| **構成コンテナ** | `zta-mcp-gateway` (1コンテナ) | `zta-mcp-gateway`<br>`test_mariadb` (NPB公式データ)<br>`mariadb-mcp`<br>`admin-procedures-mcp` (デジ庁データ) |
| **開放ポート** | `8085` のみ | `8085` (Gateway), `3306` (DB), `33060`, `33070` |
| **設定ファイル** | `config/gateway-config.core.yaml` | `config/gateway-config.sample.yaml` |
| **起動ファイル** | `docker-compose.core.yml` | `docker-compose.sample.yml` |
| **特徴** | 極めて軽量でメモリ消費が最小。<br>顧客独自の既存Upstreamサーバーに接続可能。 | 初回起動時にNPB最新データが自動投入され、<br>すぐにSQLファイアウォールや認可制御の検証が可能。 |

---

## 2. デプロイの実行方法

### 方式 A: 統合スクリプトによる選択（推奨）

ルートディレクトリの `./deploy.sh` を実行すると、対話式メニューまたはコマンドライン引数で起動できます。

#### 対話式メニューで選択
```bash
./deploy.sh
```
コンソールにメニューが表示されるので、`1`（Core）または `2`（Sample）を入力します。

#### コマンドライン引数で直接指定
```bash
# ① Gateway単体（Coreモード）を起動
./deploy.sh --core

# ② サンプルデータ付き（Sampleモード）を起動
./deploy.sh --sample

# コンテナ稼働状況を確認
./deploy.sh --status

# コンテナを停止
./deploy.sh --down
```

---

### 方式 B: 個別スクリプトによる直接実行

スクリプトを直接実行することも可能です。

#### ① Gateway単体（Coreモード）
```bash
bash scripts/deploy-core.sh
```

#### ② サンプルデータ付き（Sampleモード）
```bash
bash scripts/deploy-sample.sh
```

---

## 3. 各モードのアーキテクチャ詳細

### ① Core モードのアーキテクチャ
外部からのリクエストを受信し、JWT認証（OAuth2 Client Credentials）およびPDP/PEP認可判定を行った上で、顧客の既存社内サービスへプロキシします。

```
[ AI Agent / クライアント ]
         │ (Port 8085 / Bearer JWT)
         ▼
┌───────────────────────────┐
│     ZTA-MCP-Gateway       │
│  - A2A 認証 / JWT検証     │
│  - PEP/PDP 認可判定       │
│  - 監査ログ記録           │
└─────────────┬─────────────┘
              │ (内部通信)
              ▼
[ 顧客既存の社内MCP / API (Port 3000等) ]
```

### ② Full Sample モードのアーキテクチャ
ゼロトラストセキュリティ機能の検証・デモ用に、NPB公式戦データ（MariaDB）とデジタル庁行政手続きデータをバンドルした構成です。

```
[ AI Agent / MacOSUI ]
         │ (Port 8085 / Bearer JWT)
         ▼
┌───────────────────────────────────────────┐
│             ZTA-MCP-Gateway               │
│  - SQL Firewall (SELECTのみ許可)          │
│  - ロール別認可 (analyst vs admin)        │
└──────┬──────────────────────┬─────────────┘
       │                      │
       ▼                      ▼
┌──────────────┐       ┌──────────────────────┐
│ mariadb-mcp  │       │ admin-procedures-mcp │
│ (Port 33060) │       │ (Port 33070)         │
└──────┬───────┘       └──────────────────────┘
       │
       ▼
┌──────────────┐
│ test_mariadb │ (NPB 2024-2026年 確定公式データ)
└──────────────┘
```
