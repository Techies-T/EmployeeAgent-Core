---
description: ステージングへのデプロイ準備から脆弱性チェック、プッシュ、外部稼働確認までの一連フロー(Built-in Quality)
---

このワークフローは、**ステージング環境（さくらVPS）**へ安全かつ確実に本番同等の品質でデプロイを行うための自動化手順です。
手動でのステップ漏れを防ぐため、**一括実行スクリプト `bash scripts/deploy-staging.sh`** による完全自動実行が推奨・義務付けられています。

> [!IMPORTANT]
> このワークフローの自動デプロイ機能を利用するには、GitHubのリポジトリに以下のSecretが設定されている必要があります。
> 1. `STAGING_HOST_IP` (<YOUR_STAGING_VPS_IP>)
> 2. `STAGING_USER` (debian)
> 3. `STAGING_SSH_PRIVATE_KEY` (ローカルのSSH秘密鍵の中身)
> 4. `GHCR_PAT` (GitHubパッケージへのアクセス権限を持つPersonal Access Token)

---

### 推奨：一括自動デプロイスクリプトの実行
手動でコマンドを分割実行せず、以下のワンライナーでセキュリティ診断からリモートコンテナ更新確認までを一括強制実行します：

```bash
bash scripts/deploy-staging.sh
```

---

### 個別手順詳細

#### 1. セキュリティ診断と事前チェック (Local)
1. Node.js パッケージのソースコードレベルの脆弱性診断を実施します。
   ```bash
   npm audit --audit-level=critical
   ```

2. 実際にデプロイされるDockerイメージをキャッシュなしで一時ビルドし、コンテナ内部のOS層やベースイメージを含めた総合的なスキャン（Docker Scout）を実行します。
   ```bash
   docker build --no-cache -t macosui-staging-test .
   docker scout cves macosui-staging-test --exit-code --only-severity critical
   ```
   > [!CAUTION]
   > `npm audit` または `docker scout` のスキャンで `CRITICAL`（致命的）な脆弱性が発見された場合は、**コマンドがエラー終了し、以降のステージングへのデプロイ作業は完全に中止（ブロック）されます**。
   > 脆弱性を修正（`npm audit fix` や Dockerfileのベースイメージ更新など）するまでデプロイできません。

#### 2. コードのコミットとStagingへのPush
2. Gitの現在の変更内容を確認し、問題なければコミットとプッシュを行います。
   ```bash
   git add .
   git commit -m "chore: deploy to staging"
   git push origin staging
   ```

#### 3. GitHub Actions による自動デプロイ監視
3. ブラウザでGitHubのActionsページ（`https://github.com/minoru61/MacOSUI/actions`）を開き、最新のワークフローがエラーなく完了するかを確認してください。
   目安として、完了までに1分〜2分程度かかります。
   ```bash
   sleep 45 && ssh -i ~/.ssh/id_ed25519_vps -o StrictHostKeyChecking=no debian@<YOUR_STAGING_VPS_IP> "docker ps" && curl -s https://macosui-staging.techiespod.co.jp/api/health
   ```

---

### 4. 実行完了エビデンスチェックリスト (AI必須確認)
報告時、以下のエビデンスを提示すること:
- [ ] `npm audit` で CRITICAL 0 件の出力
- [ ] `docker scout cves` で `No critical vulnerabilities found` の出力
- [ ] VPS 上の `docker ps` で `macosui-web` コンテナが数秒〜数分前に再生成されたことのログ
