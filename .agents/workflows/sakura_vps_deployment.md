# さくらのVPS ステージング環境 自動構築・自動デプロイ手順書

この手順書は、Ansibleを利用したインフラストラクチャーとしてのコード(IaC)と、GitHub Actionsを通じた自動デプロイメント(CI/CD)を活用して、さくらのVPSにデモ/ステージング環境を全自動で構築・更新するためのドキュメントです。

## 前提条件

- **OSの選択**: `Debian 12` (今回構築したベースOSです)
- **管理用パスワード / SSH鍵**: セキュリティを高めるため「パスワードなしの公開鍵認証」を推奨します。
- **SSHキー**: 例として `~/.ssh/id_ed25519_vps` を使用します。

---

## 第1部: サーバーの自動構築（Ansible - IaC）

Ansibleを使って、新しく作成した(または初期化した)何もないDebianサーバーに対して、UFW(ファイアウォール)やDocker・Docker Composeなどを全自動でインストールします。

### 手順

1. まず、お手元のMacにAnsibleがインストールされていない場合はインストールしてください。
   ```bash
   brew install ansible
   ```

2. `ansible/inventory.ini` ファイルを開き、新しいIPアドレスが記載されていることを確認します（今回は `<YOUR_STAGING_VPS_IP>` が記載されています）。

3. 以下のAnsibleコマンドを実行するだけで、全ての設定が完了します！
   ```bash
   cd ansible
   ansible-playbook -i inventory.ini setup-vps.yml --ask-become-pass
   ```
   > 実行時に聞かれる `BECOME password` は、サーバーの管理用パスワード（例: sakura等）を入力してください。

---

## 第2部: GitHub Actionsを通じた自動デプロイ（CI/CD）

手動での `rsync` や `docker compose up` はもう不要です。
設定を一度行えば、今後は **`staging` ブランチにプッシュするだけで数分で自動的に本番サーバーが更新** されます。

### 1. サーバー内での環境ファイルの準備
初回のみ、稼働させるVPSサーバーにログインし、環境変数の実体ファイルを作成します。安全のためGitHub（コードリポジトリ）には絶対に含めません。

```bash
ssh -i ~/.ssh/id_ed25519_vps debian@<サーバーのIPアドレス>
mkdir -p ~/MacOSUI/server

# ステージング用の本番APIキー等を含んだセキュアなenvファイルを作ります
nano ~/MacOSUI/server/staging.env
```

### 2. GitHubへのシークレット変数の登録
GitHub ActionsがVPSサーバーに「rsyncでのファイル転送」と「SSH実行」を行えるようにするため、ご自身のGitHubの対象リポジトリ画面から、以下の3つの秘密の環境変数を登録します。

- 画面遷移: `Settings` タブ > 左メニュー `Secrets and variables` > `Actions` > **`New repository secret`**

#### 登録する値
1. **`STAGING_HOST_IP`**
   - 値: `<YOUR_STAGING_VPS_IP>` (さくらのVPSのIPアドレス)
2. **`STAGING_USER`**
   - 値: `debian` (SSH接続ユーザー名)
3. **`STAGING_SSH_PRIVATE_KEY`**
   - 値: Macにある `~/.ssh/id_ed25519_vps` の**中身をそのまま全コピー**したもの。
   - `cat ~/.ssh/id_ed25519_vps` または `pbcopy < ~/.ssh/id_ed25519_vps` でコピーしてください。

### 3. デプロイの実行（Git Push）
あとは普段通りにコードを修正し、`staging` ブランチという名前でGitHubにPushするだけです！

```bash
git checkout -b staging
git push origin staging
```

GitHub上の `Actions` タブから、ロボットが自動でVPSに接続し、同期し、Dockerを再ビルドして起動してくれる様子を眺めることができます。

---

## 3. ドメイン・証明書 (HTTPS化) の設定について

ステージング環境を `macosui-staging.techiespod.co.jp` として本公開するための設定です。

1. **DNS設定:** ドメイン管理業者のコンソールにて Aレコード（`macosui-staging` -> `<YOUR_STAGING_VPS_IP>`）を登録します。
2. **証明書発行スクリプトの実行:** (サーバー内で1回だけ叩きます)
   ```bash
   cd ~/MacOSUI
   bash scripts/get-letsencrypt.sh macosui-staging.techiespod.co.jp
   ```
3. **NGINXへドメイン名を教える:** (サーバー内で1回だけ叩きます)
   ```bash
   echo "DOMAIN_NAME=macosui-staging.techiespod.co.jp" > ~/MacOSUI/.env
   # その後 docker compose を再起動
   ENV_FILE=staging.env docker compose up -d
   ```
