# AWS Aurora (MySQL互換) / AWS RDS (MariaDB・MySQL) IAM 認証 MCP サーバー導入ガイド

本ドキュメントは、Zero Trust Architecture (ZTA) 準拠の独立 MCP サーバー **`aurora-rds-mcp`**（Port: `33080`）を用いて、お客様の **AWS Aurora (MySQL 互換)** および **AWS RDS (MariaDB / MySQL)** へ **静的パスワード不要（IAM 認証 + TLS 強制）** で安全に接続するための導入手順をまとめたものです。

---

## 1. セキュリティアーキテクチャ概要

`aurora-rds-mcp` は、以下の ZTA セキュリティ要件を満たすよう設計されています。

1. **静的パスワードレス（SigV4 IAM 認証）**:
   - `@aws-sdk/rds-signer` を使用し、有効期限 15 分（900 秒）の一時的な SigV4 IAM 認証トークンを発行します。
   - **サイレントリフレッシュ**: 期限切れ前の **12 分間隔** でバックグラウンドにて自動リフレッシュし、接続プールへシームレスに供給します。
2. **TLS 暗号化通信の強制**:
   - 本番 `iam` モードでは TLS 1.2 以上を強制有効化し、Amazon RDS グローバル CA 証明書バンドル（`/etc/ssl/certs/rds-global-bundle.pem`）によるサーバー証明書検証（`rejectUnauthorized: true`）を行います。
3. **ZTA 準拠 SSE トランスポート**:
   - `GET /sse`、`POST /message`、`GET /health` を提供します。`ZTA-MCP-Gateway` の背後に配置することで、OAuth 2.0 JWT による A2A 認証・RBAC・SQL ファイアウォールと多層防御を構成できます。
4. **厳格な Read-Only SQL ガード（デフォルト ON）**:
   - `DB_READ_ONLY=true`（既定値）の場合、`SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` 以外の変更系 SQL（`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT` 等）やマルチステートメント（`;`）、ファイル出力（`INTO OUTFILE`）、排他ロック（`FOR UPDATE`）を厳格にブロックします。

---

## 2. 接続モードの選択（`DB_AUTH_MODE`）

環境変数 `DB_AUTH_MODE` により、用途に応じた 3 種類のモードを切り替えられます。

| モード (`DB_AUTH_MODE`) | 用途 | 認証方式・特徴 | AWS 課金 |
| :--- | :--- | :--- | :--- |
| **`iam`**（本番推奨） | 本番 Aurora MySQL / RDS MariaDB・MySQL | `@aws-sdk/rds-signer` で 15 分有効の SigV4 トークンを発行・12 分自動リフレッシュ。TLS 必須。EC2 IAM ロール自動継承または STS AssumeRole 対応。 | お客様の Aurora/RDS 利用料のみ |
| **`awslabs_mysql`** | AWS 公式 MCP サーバー連携 | AWS 公式 `awslabs.mysql-mcp-server`（`mysqlwire_iam`）を `uvx` 子プロセス起動し、SSE へブリッジ。（イメージビルド時に `--build-arg ENABLE_AWSLABS_MYSQL=true` が必要） | お客様の Aurora/RDS 利用料のみ |
| **`sandbox_sim`**（初期値） | ローカル開発・デモ・動作確認 | `@aws-sdk/rds-signer` で実際の SigV4 トークン生成・形式検証・サイレントリフレッシュを実行しつつ、接続先はローカルの `test_mariadb` を使用。 | **0 円** |

---

## 3. AWS 側セットアップ手順

### 3.1 Aurora / RDS で IAM DB 認証を有効化する

AWS マネジメントコンソール（変更 → データベース認証 → **パスワードと IAM データベース認証**）または以下の AWS CLI で有効化します。

**Aurora (MySQL 互換) クラスタの場合:**

```bash
aws rds modify-db-cluster \
  --region ap-northeast-1 \
  --db-cluster-identifier <your-aurora-cluster-id> \
  --enable-iam-database-authentication \
  --apply-immediately
```

**RDS (MariaDB / MySQL) インスタンスの場合:**

```bash
aws rds modify-db-instance \
  --region ap-northeast-1 \
  --db-instance-identifier <your-rds-instance-id> \
  --enable-iam-database-authentication \
  --apply-immediately
```

あわせて、`DbiResourceId`（クラスタの場合は `DbClusterResourceId`）を確認してください。IAM ポリシーの ARN 指定に使用します。

```bash
# Aurora クラスタの場合
aws rds describe-db-clusters \
  --region ap-northeast-1 \
  --db-cluster-identifier <your-aurora-cluster-id> \
  --query 'DBClusters[0].DbClusterResourceId' --output text

# RDS インスタンスの場合
aws rds describe-db-instances \
  --region ap-northeast-1 \
  --db-instance-identifier <your-rds-instance-id> \
  --query 'DBInstances[0].DbiResourceId' --output text
```

---

### 3.2 IAM ポリシー JSON（最小権限 `rds-db:connect`）

EmployeeAgent を稼働させる EC2 インスタンスの IAM ロール（推奨）、または `AURORA_RDS_ROLE_ARN` で引き受ける専用 IAM ロールに以下の最小権限ポリシーをアタッチしてください。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAuroraRdsIamConnect",
      "Effect": "Allow",
      "Action": [
        "rds-db:connect"
      ],
      "Resource": [
        "arn:aws:rds-db:ap-northeast-1:<AWS_ACCOUNT_ID>:dbuser:<DB_RESOURCE_ID>/ea_iam_readonly"
      ]
    }
  ]
}
```

- `<AWS_ACCOUNT_ID>`: 12 桁の AWS アカウント ID
- `<DB_RESOURCE_ID>`: 3.1 で取得した `cluster-XXXX...` または `db-XXXX...`
- `ea_iam_readonly`: 3.3 で作成する DB ユーザー名

#### クロスアカウント / 専用ロールを引き受ける場合（任意）

`AURORA_RDS_ROLE_ARN` を指定する場合は、実行元 EC2 ロール側に `sts:AssumeRole` 権限を付与し、引き受け先ロールの信頼ポリシーで実行元ロールを許可してください。未指定（空）の場合は **EC2 インスタンスプロファイル（IMDSv2）の IAM ロールを自動継承** します。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeAuroraRdsRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<TARGET_ACCOUNT_ID>:role/<AURORA_RDS_CONNECT_ROLE>"
    }
  ]
}
```

---

### 3.3 データベース側ユーザー作成 SQL（Read-Only 最小権限）

管理者ユーザーで Aurora / RDS に接続し、`AWSAuthenticationPlugin` を使用する IAM 認証ユーザーを作成します。

```sql
-- 1. IAM 認証用 DB ユーザーを作成（パスワード不要）
CREATE USER 'ea_iam_readonly'@'%'
  IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';

-- 2. 対象データベースに対する読み取り専用権限（SELECT のみ）を付与
GRANT SELECT ON `<YOUR_DATABASE_NAME>`.* TO 'ea_iam_readonly'@'%';

-- 3. スキーマ確認用（information_schema 参照は標準で許可されますが念のため反映）
FLUSH PRIVILEGES;

-- 4. 作成確認
SELECT User, Host, plugin FROM mysql.user WHERE User = 'ea_iam_readonly';
```

> [!IMPORTANT]
> **TLS 接続の強制**: 必要に応じてユーザー作成時に `REQUIRE SSL` を追加することで、DB サーバー側でも TLS なしの接続を拒否できます。
> ```sql
> ALTER USER 'ea_iam_readonly'@'%' REQUIRE SSL;
> ```

---

### 3.4 ネットワーク・セキュリティグループ設定

- Aurora / RDS のセキュリティグループにおいて、EmployeeAgent（`aurora-rds-mcp` コンテナ稼働ホスト）のセキュリティグループまたはプライベート IP からの **TCP `3306`** インバウンド通信を許可してください。
- インターネット経由の公開は避け、VPC 内プライベートサブネット（または VPC ピアリング / Transit Gateway）経由で接続することを強く推奨します。

---

## 4. `aurora-rds-mcp` の設定と起動

### 4.1 環境変数リファレンス

| 環境変数 | 必須 | 既定値 | 説明 |
| :--- | :---: | :--- | :--- |
| `MCP_PORT` | - | `33080` | MCP サーバー待ち受けポート |
| `DB_AUTH_MODE` | ○ | `sandbox_sim` | `iam` / `awslabs_mysql` / `sandbox_sim` |
| `AURORA_RDS_ENGINE` | - | `auto` | `aurora-mysql` / `rds-mariadb` / `rds-mysql` / `auto` |
| `AURORA_RDS_HOST` | ○(`iam`) | - | Aurora クラスタエンドポイントまたは RDS エンドポイント |
| `AURORA_RDS_PORT` | - | `3306` | DB ポート番号 |
| `AURORA_RDS_USER` | ○(`iam`) | `iam_readonly` | IAM 認証 DB ユーザー名（例: `ea_iam_readonly`） |
| `AURORA_RDS_DATABASE` | ○(`iam`) | `testdb` | 接続先データベース名 |
| `AWS_REGION` | ○(`iam`) | `ap-northeast-1` | AWS リージョン |
| `AURORA_RDS_ROLE_ARN` | - | （空） | STS AssumeRole 先 ARN（空の場合は EC2 IAM ロール自動継承） |
| `DB_READ_ONLY` | - | `true` | `true` で Read-Only SQL ガードを強制有効化 |
| `DB_SSL_CA_PATH` | - | `/etc/ssl/certs/rds-global-bundle.pem` | Amazon RDS CA 証明書バンドルのパス |
| `DB_SSL_REJECT_UNAUTHORIZED` | - | `true` | TLS サーバー証明書検証の有効化 |
| `IAM_TOKEN_REFRESH_INTERVAL_MS` | - | `720000` (12分) | IAM トークンのサイレントリフレッシュ間隔（ミリ秒） |

### 4.2 単体 Docker 起動例（本番 `iam` モード）

```bash
cd zta-mcp-stack/services/aurora-rds-mcp

# ビルド（通常 Node.js iam モード）
docker build -t techies-t/aurora-rds-mcp:latest .

# ※ awslabs.mysql-mcp-server ブリッジも同梱する場合
# docker build --build-arg ENABLE_AWSLABS_MYSQL=true -t techies-t/aurora-rds-mcp:latest .

# 起動例（EC2 IAM ロール継承）
docker run -d --name aurora-rds-mcp \
  -p 33080:33080 \
  -e DB_AUTH_MODE=iam \
  -e AURORA_RDS_ENGINE=aurora-mysql \
  -e AURORA_RDS_HOST=mydb.cluster-xxxxxxxxxxxx.ap-northeast-1.rds.amazonaws.com \
  -e AURORA_RDS_PORT=3306 \
  -e AURORA_RDS_USER=ea_iam_readonly \
  -e AURORA_RDS_DATABASE=appdb \
  -e AWS_REGION=ap-northeast-1 \
  -e DB_READ_ONLY=true \
  techies-t/aurora-rds-mcp:latest
```

### 4.3 ヘルスチェック確認

```bash
curl -s http://localhost:33080/health | jq .
```

`iamToken.tokenValid: true` および `iamToken.remainingSeconds`（最大 900 秒）が返却されることを確認してください。

---

## 5. 提供する MCP ツール

| ツール名 | 概要 |
| :--- | :--- |
| `list_tables` | 接続先データベースのテーブル一覧（種別・エンジン・概算行数）を取得します。 |
| `describe_table` | 指定したテーブルのカラム定義・型・キー情報を取得します。 |
| `execute_query` | SQL クエリを実行します（`DB_READ_ONLY=true` 時は `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` のみ許可）。 |
| `check_connection_status` | DB 疎通状態、エンジン種別、TLS 検証状態、IAM トークンの有効性・残り有効期限・リフレッシュ回数を返却します。 |

---

## 6. 15 分ワンショット実機検証スクリプト（任意）

本番環境へ導入する前に、一時的な RDS MariaDB (`db.t4g.micro`) を自動作成して IAM 認証・TLS・Read-Only ガードを実機テストし、終了後に即削除するスクリプトを用意しています。

```bash
cd zta-mcp-stack
./scripts/test-rds-iam-oneshot.sh --region ap-northeast-1
```

- 実行前に確認プロンプトが表示されます（`--yes` でスキップ可）。
- スクリプトが正常終了しても途中でエラー・`Ctrl+C` になっても、`trap` により一時 RDS インスタンスとセキュリティグループが自動削除されます。

---

## 7. トラブルシューティング

| 症状 | 主な原因と対処方法 |
| :--- | :--- |
| `Access denied for user 'ea_iam_readonly'` | 1) RDS/Aurora で IAM DB 認証が有効化されているか確認。<br>2) IAM ポリシーの `DbiResourceId`（`cluster-...` vs `db-...`）と DB ユーザー名が完全一致しているか確認。<br>3) `AURORA_RDS_HOST` が実際のエンドポイントと一致しているか確認（IP アドレス指定では SigV4 署名が失敗します）。 |
| `SELF_SIGNED_CERT_IN_CHAIN` / TLS エラー | `DB_SSL_CA_PATH` に Amazon RDS グローバル CA バンドル（`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`）が配置されているか確認してください。 |
| `Blocked by SQL Guard` | `DB_READ_ONLY=true` が有効です。変更系 SQL をブロックしています。読み取りクエリ（`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`）のみ実行してください。 |
| `awslabs_mysql` モードで `uvx` が見つからない | Docker イメージを `--build-arg ENABLE_AWSLABS_MYSQL=true` 付きで再ビルドするか、通常の `DB_AUTH_MODE=iam` を使用してください。 |
