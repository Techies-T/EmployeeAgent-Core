# EA-Widget プラグイン基盤 & PQC ハイブリッドコード署名アーキテクチャ仕様書

本ドキュメントは、`EmployeeAgent-Core`（以下 EA-Core）における独立ウィジェット・プラグイン機構（`EA-Widget Plugin Protocol v1`）の設計仕様、サプライチェーン保護のための **耐量子計算機暗号（PQC）ハイブリッド署名 & GitHub Build Provenance 検証**、および暗号方式選定に関する **設計判断記録（ADR: Architecture Decision Record）** を定義する公式アーキテクチャ仕様書です。

---

## 1. 目的と背景

従来のモノリシック構成では、各ウィジェット（Virtual Office 等）が EA-Core 本体のフロントエンド（`src/apps/`）およびバックエンド（`server/index.cjs`）にハードコードされており、単一ウィジェットの UI 修正や機能改善のたびに EA-Core 全体の再ビルド・再デプロイが必要でした。

本アーキテクチャでは以下を実現します。
1. **完全な疎結合・独立開発**: 各ウィジェットを独立したプロジェクト（別リポジトリ・別コンテナ）として開発・ビルドでき、**EA-Core 本体を一切再ビルドすることなく** プラグイン追加・バージョンアップが可能。
2. **ゼロトラスト（ZTA）認可統合**: RFC 8693 Token Exchange による短命 Agent JWT 配布、ZTA PDP（`RBAC_POLICIES`）に基づく4段階権限（`none` / `read` / `execute` / `manage`）の動的強制（PEP）、および Core Platform Host API（`/api/core/host/*`）による安全な OS リソースアクセス。
3. **悪意ある第三者コード・改ざんの完全排除**: 当社独自の **PQC ハイブリッド電子署名（`Ed25519` + `NIST FIPS 204 ML-DSA-65`）** と **GitHub Build Provenance（製造元証明）** の二重署名検証（Gatekeeper）により、未承認・改ざんウィジェットのロードを 100% ブロック。

---

## 2. 二重署名（Dual-Layer Signature）と秘密鍵管理アーキテクチャ

### 2.1 2種類の Signature の役割分担

| 署名レイヤー | 技術規格 | 証明する対象（セキュリティ保証） |
| :--- | :--- | :--- |
| **Layer 1: 当社コード署名**<br>*(Publisher Hybrid Signature)* | 古典 `Ed25519` ＋<br>耐量子 `ML-DSA-65` (`NIST FIPS 204`) | **配布経路非依存の真正性・未改ざん証明**<br>GitHub リリース経由でも、将来の当社公式ポータルからのダウンロード配布やオンプレ閉域網への持ち込みでも、「当社が公式承認し、1バイトも改ざんされていない正規コードであること」を EA-Core 単体（オフライン可）で即時検証する。 |
| **Layer 2: GitHub 署名**<br>*(Build Provenance)* | GitHub Artifact Attestations<br>(Sigstore OIDC 署名) | **製造ライン（CI/CD）の出所証明**<br>個人のローカル端末で不正に細工されたビルドではなく、正規の GitHub リポジトリおよび GitHub Actions ワークフローから自動ビルドされた成果物であることを証明する。 |

### 2.2 秘密鍵の安全な管理ルール

| 環境 | 保管場所 | 運用・セキュリティ原則 |
| :--- | :--- | :--- |
| **本番リリース環境**<br>*(Production)* | **AWS KMS 非対称署名キー**<br>（FIPS 140-3 Level 3 認定 HSM） | 秘密鍵は AWS KMS のハードウェア内部で生成され、**外部へのエクスポートが物理的に不可能**。GitHub Actions から OIDC 一時 IAM ロール認証を通じて `kms:Sign`（`ML_DSA_SHAKE_256`）を呼び出しハッシュ値に署名するため、秘密鍵ファイルの流出リスクが構造上ゼロとなる。 |
| **ローカル開発環境**<br>*(Development)* | **`server/development.env`**<br>（Git 管理対象外） | 開発専用のテスト鍵ペア（`PLUGIN_DEV_*`）を `server/development.env` に保持し、AWS 非接続時でも手元で即座に署名・動作検証が可能。本番環境（`NODE_ENV=production`）では開発鍵による署名は Gatekeeper が自動的に拒否する。 |
| **EA-Core 本体**<br>*(検証側)* | **公開鍵（Public Key）のみ同梱** | EA-Core には公開鍵のみを登録するため、OSS 公開環境であっても第三者による署名偽造は一切不可能。 |

---

## 3. 設計判断記録（ADR）：PQC 署名導入に関する「案1」と「案2」の比較・採択理由

### 3.1 背景（PQC デジタル署名の標準化動向）
- 通信の鍵交換における PQC（`ML-KEM` / FIPS 203）に続き、デジタル署名・証明書向けの PQC アルゴリズムも **2024年8月に米国 NIST により `FIPS 204 (ML-DSA)` として標準化が完了** しており、AWS KMS でも `ML_DSA_65` がすでにネイティブ提供されている。
- パブリック Web の HTTPS 証明書（公開認証局）は署名サイズ（約 3.3KB）に起因する TLS ハンドシェイク軽量化調整のため 2027〜2028年以降の本格普及が見込まれる一方、**自社管理のコード署名（プラグイン検証）においてはサイズ制約がなく今すぐ実用可能** である。

### 3.2 検討した選択肢の比較

| 比較項目 | **【採択】案1：初期リリースから PQC ハイブリッド署名を実装**<br>(`Ed25519` + `ML-DSA-65` + GitHub署名) | **案2：まずは古典暗号のみで実装（構造のみPQC対応）**<br>(`Ed25519` + GitHub署名) |
| :--- | :--- | :--- |
| **外部 npm パッケージ依存**<br>*(Built-in Quality)* | 現行 Node.js v20（OpenSSL 3.0）には `ML-DSA` が標準搭載されていないため、ゼロ依存・第三者監査済みパッケージ `@noble/post-quantum` を1つ追加する（脆弱性 0件を確認済）。 | **外部パッケージ追加ゼロ**。<br>Node.js 標準組み込みの `crypto` モジュールのみで完結する最小構成。 |
| **AWS KMS の鍵管理コスト** | KMS 上で古典鍵と `ML_DSA_65` 鍵の2本を管理・署名実行（月額 約\$2）。 | KMS キー1本のみでシンプルに運用可能（月額 約\$1）。 |
| **今後5年スパンの実質安全性** | 量子計算機耐性を含め現時点で最高水準。 | コード署名は「インストール時点での偽造防止」が目的のため、実用的な暗号解読量子計算機が登場する2030年代までは実用上の安全性は同等。 |
| **中長期保守性 & 事業優位性** | ・**将来の PQC 移行に伴う EA-Core 本体の再改修・再ビルド・顧客環境アップデートが完全に不要**。<br>・官公庁・デジタル庁・金融・エンタープライズ提案において **「NIST FIPS 204 (ML-DSA) 耐量子コード署名実装済みのゼロトラスト AI エージェント基盤」** として強力な技術的差別化となる。 | 将来 Node.js ランタイム標準 `crypto` が OpenSSL 3.5+ ベースへ更新されたタイミングで、本体側の検証ロジックをアップデートする。 |

### 3.3 決定事項（Decision）
上記の比較検討の結果、**「EA-Core 本体の将来改修を極小化する」というマイクロカーネル化の本質的ゴールとの一致**、および **公共・エンタープライズ領域における先進セキュリティ基盤としての競争優位性** を重視し、**案1（`Ed25519` ＋ `ML-DSA-65` ハイブリッド署名 ＋ GitHub Provenance 署名）** を正式採択する。

---

## 4. プラグイン署名・検証コマンドリファレンス

```bash
# 1. ローカル開発用 PQC ハイブリッド鍵ペアの初期化 (server/development.env に保存)
node scripts/sign-widget-plugin.cjs --keygen-dev

# 2. 独立ウィジェットプロジェクトのビルド成果物ハッシュ算出 & PQC ハイブリッド署名付与
node scripts/sign-widget-plugin.cjs --dir "../ea-widget-virtual-office"

# 3. GitHub Actions 本番リリース時の AWS KMS (ML_DSA_65) 署名
node scripts/sign-widget-plugin.cjs --dir "." --mode aws-kms \
  --kms-mldsa-key-id "$AWS_KMS_MLDSA65_KEY_ID" \
  --repo "$GITHUB_REPOSITORY"
```
